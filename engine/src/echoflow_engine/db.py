"""SQLite store: history entries (with full-text search), settings and the personal dictionary."""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from pathlib import Path

from .secrets_store import SecretStore

SECRET_KEYS = {"gemini_key", "openai_key"}

DEFAULT_SETTINGS = {
    "hotkey": "Control+Space",
    "note_hotkey": "Control+Shift+Space",
    "toggle_mode": False,           # False = hold to talk
    "style": "auto",                # auto | clean | bullets | todo | email | message
    "provider": "rules",            # rules | gemini | openai
    "gemini_model": "gemini-2.5-flash",
    "openai_base_url": "https://api.openai.com/v1",
    "openai_model": "gpt-4o-mini",
    "whisper_model": "auto",        # auto | large-v3-turbo | small.en | base.en ...
    "keep_text": True,
    "keep_audio": False,
    "launch_at_login": False,
    "auto_update": True,
    "app_styles": {"gmail": "email", "outlook": "email", "mail": "email", "slack": "message",
                   "discord": "message", "whatsapp": "message", "teams": "message", "claude": "message",
                   "chatgpt": "message", "notion": "clean", "code": "clean", "word": "clean"},
    "note_template": "meeting",
    "note_sources": "mic",          # mic | system | both
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  created_at REAL NOT NULL,
  app TEXT DEFAULT '',
  style TEXT DEFAULT 'clean',
  raw TEXT DEFAULT '',
  cleaned TEXT DEFAULT '',
  title TEXT DEFAULT '',
  duration REAL DEFAULT 0,
  provider TEXT DEFAULT 'rules',
  flags TEXT DEFAULT '',
  tags TEXT DEFAULT ''
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(raw, cleaned, title, content='entries', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, raw, cleaned, title) VALUES (new.id, new.raw, new.cleaned, new.title);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, raw, cleaned, title) VALUES ('delete', old.id, old.raw, old.cleaned, old.title);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, raw, cleaned, title) VALUES ('delete', old.id, old.raw, old.cleaned, old.title);
  INSERT INTO entries_fts(rowid, raw, cleaned, title) VALUES (new.id, new.raw, new.cleaned, new.title);
END;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS terms (term TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS replacements (src TEXT PRIMARY KEY, dst TEXT);
"""

UPDATABLE = {"cleaned", "raw", "title", "style", "tags", "provider", "flags"}


def _fts_query(text: str) -> str:
    words = re.findall(r"[\w']+", text)
    return " ".join(f'"{w}"*' for w in words)


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.executescript(SCHEMA)
            self.db.commit()
        self.secrets = SecretStore(self.path.with_name("secrets.json"))

    # ------------------------------------------------------------ entries
    def add_entry(self, kind: str, raw: str, cleaned: str, app: str = "", style: str = "clean",
                  duration: float = 0.0, title: str = "", provider: str = "rules", flags: str = "",
                  tags: str = "") -> int:
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO entries(kind,created_at,app,style,raw,cleaned,title,duration,provider,flags,tags) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (kind, time.time(), app, style, raw, cleaned, title, duration, provider, flags, tags))
            self.db.commit()
            return cur.lastrowid

    def get(self, entry_id: int) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone()
        return dict(row) if row else None

    def search(self, text: str = "", kind: str = "", app: str = "", since: float = 0,
               limit: int = 200) -> list[dict]:
        sql, args = "SELECT e.* FROM entries e", []
        where = []
        q = _fts_query(text)
        if q:
            sql += " JOIN entries_fts f ON f.rowid = e.id"
            where.append("entries_fts MATCH ?")
            args.append(q)
        if kind:
            where.append("e.kind=?"); args.append(kind)
        if app:
            where.append("e.app=?"); args.append(app)
        if since:
            where.append("e.created_at>=?"); args.append(since)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY e.created_at DESC, e.id DESC LIMIT ?"
        args.append(limit)
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def apps(self) -> list[str]:
        with self.lock:
            return [r[0] for r in self.db.execute("SELECT DISTINCT app FROM entries WHERE app!='' ORDER BY app")]

    def update(self, entry_id: int, **fields) -> None:
        fields = {k: v for k, v in fields.items() if k in UPDATABLE}
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        with self.lock:
            self.db.execute(f"UPDATE entries SET {sets} WHERE id=?", (*fields.values(), entry_id))
            self.db.commit()

    def delete(self, entry_id: int) -> None:
        with self.lock:
            self.db.execute("DELETE FROM entries WHERE id=?", (entry_id,))
            self.db.commit()

    def clear(self) -> None:
        with self.lock:
            self.db.execute("DELETE FROM entries")
            self.db.commit()

    # ------------------------------------------------------------ settings
    def settings(self) -> dict:
        out = dict(DEFAULT_SETTINGS)
        with self.lock:
            for r in self.db.execute("SELECT key,value FROM settings"):
                out[r["key"]] = json.loads(r["value"])
        for k in SECRET_KEYS:
            out[k] = "set" if self.secrets.has(k) else ""
        return out

    def set_settings(self, values: dict) -> None:
        with self.lock:
            for k, v in values.items():
                if k in SECRET_KEYS:
                    if v != "set":  # the UI echoes "set" back when unchanged
                        self.secrets.set(k, v or "")
                elif k in DEFAULT_SETTINGS:
                    self.db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(v)))
            self.db.commit()

    def secret(self, name: str) -> str:
        return self.secrets.get(name)

    # ------------------------------------------------------------ dictionary
    def add_term(self, term: str) -> None:
        with self.lock:
            self.db.execute("INSERT OR IGNORE INTO terms(term) VALUES(?)", (term.strip(),))
            self.db.commit()

    def remove_term(self, term: str) -> None:
        with self.lock:
            self.db.execute("DELETE FROM terms WHERE term=?", (term,))
            self.db.commit()

    def add_replacement(self, src: str, dst: str) -> None:
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO replacements(src,dst) VALUES(?,?)", (src.strip().lower(), dst))
            self.db.commit()

    def remove_replacement(self, src: str) -> None:
        with self.lock:
            self.db.execute("DELETE FROM replacements WHERE src=?", (src.strip().lower(),))
            self.db.commit()

    def dictionary(self) -> dict:
        with self.lock:
            terms = [r[0] for r in self.db.execute("SELECT term FROM terms ORDER BY term")]
            reps = {r[0]: r[1] for r in self.db.execute("SELECT src,dst FROM replacements ORDER BY src")}
        return {"terms": terms, "replacements": reps}
