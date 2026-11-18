"""HTTP API for the shell and the dashboard. Local only; every /api call needs the per-launch token."""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import __version__, cleanup, notes, providers
from .db import Store
from .transcribe import SR, is_silent


def create_app(store: Store, tx, token: str, ui_dir: Path | None, data_dir: Path) -> FastAPI:
    app = FastAPI(title="EchoFlow engine", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    state = {"note": None, "note_meta": {}}
    recovery_path = Path(data_dir) / "note-recovery.json"

    def auth(request: Request):
        if request.headers.get("x-echo-token") != token and request.query_params.get("token") != token:
            raise HTTPException(401, "bad token")

    api = {"dependencies": [Depends(auth)]}

    def prov():
        return providers.get_provider(store.settings(), store.secret)

    def prompt_terms() -> str:
        return ", ".join(store.dictionary()["terms"])

    # recover a note that was interrupted by a crash
    text = notes.recover(recovery_path)
    if text:
        md = notes.build_note(text, "meeting", None)
        store.add_entry("note", raw=text, cleaned=md, title=notes.note_title(md) + " (recovered)",
                        style="meeting", flags="recovered")
        recovery_path.unlink(missing_ok=True)

    # ------------------------------------------------------------ health
    @app.get("/api/health", **api)
    def health():
        return {"version": __version__, "ready": tx.ready, "loading": tx.loading, "error": tx.error,
                "stage": getattr(tx, "stage", ""),
                "hardware": tx.info, "note_active": state["note"] is not None,
                "provider": store.settings()["provider"]}

    # ------------------------------------------------------------ dictation
    @app.post("/api/dictate", **api)
    async def dictate(request: Request, app_name: str = "", style: str = ""):
        pcm = np.frombuffer(await request.body(), dtype=np.float32)

        def work():
            if not tx.ready:
                raise HTTPException(503, "model not ready")
            t0 = time.perf_counter()
            settings = store.settings()
            if is_silent(pcm):
                return {"empty": True}
            raw, _ = tx.run(pcm, prompt=prompt_terms())
            if not raw:
                return {"empty": True}
            chosen = style or cleanup.resolve_style(settings, app_name)
            cleaned, used, flags = cleanup.clean(raw, chosen, store.dictionary(), app_name, provider=prov())
            entry_id = None
            if settings["keep_text"]:
                entry_id = store.add_entry("dictation", raw=raw, cleaned=cleaned, app=app_name, style=chosen,
                                           duration=len(pcm) / SR, provider=used, flags=flags)
            return {"empty": False, "id": entry_id, "raw": raw, "cleaned": cleaned, "style": chosen,
                    "provider": used, "flags": flags, "ms": int((time.perf_counter() - t0) * 1000)}
        return await run_in_threadpool(work)

    # ------------------------------------------------------------ notes
    @app.post("/api/notes/start", **api)
    def note_start(body: dict | None = None):
        if state["note"] is not None:
            raise HTTPException(409, "a note session is already running")
        if not tx.ready:
            raise HTTPException(503, "model not ready")
        body = body or {}
        state["note"] = notes.NoteSession(tx, recovery_path, prompt=prompt_terms())
        state["note_meta"] = {"template": body.get("template") or store.settings()["note_template"],
                              "started": time.time()}
        return {"ok": True}

    @app.post("/api/notes/chunk", **api)
    async def note_chunk(request: Request):
        session = state["note"]
        if session is None:
            raise HTTPException(409, "no note session")
        pcm = np.frombuffer(await request.body(), dtype=np.float32)
        await run_in_threadpool(session.append, pcm)
        return {"seconds": session.seconds}

    @app.get("/api/notes/live", **api)
    def note_live():
        s = state["note"]
        if s is None:
            return {"active": False}
        return {"active": True, "seconds": s.seconds, "transcript": s.transcript(),
                "template": state["note_meta"]["template"]}

    @app.post("/api/notes/finish", **api)
    def note_finish():
        session = state["note"]
        if session is None:
            raise HTTPException(409, "no note session")
        transcript = session.finish()
        template = state["note_meta"]["template"]
        state["note"] = None
        if not transcript.strip():
            session.close()
            return {"empty": True}
        md = notes.build_note(transcript, template, prov())
        entry_id = store.add_entry("note", raw=transcript, cleaned=md, title=notes.note_title(md), style=template,
                                   duration=session.seconds, provider=(prov().name if prov() else "rules"))
        session.close()
        return {"empty": False, "id": entry_id, "entry": store.get(entry_id)}

    @app.post("/api/notes/cancel", **api)
    def note_cancel():
        s, state["note"] = state["note"], None
        if s:
            s.close()
        return {"ok": True}

    # ------------------------------------------------------------ entries
    @app.get("/api/entries", **api)
    def entries(q: str = "", kind: str = "", app_name: str = "", since: float = 0, limit: int = 200):
        return store.search(q, kind=kind, app=app_name, since=since, limit=limit)

    @app.get("/api/apps", **api)
    def apps():
        return store.apps()

    @app.get("/api/entries/{entry_id}", **api)
    def entry(entry_id: int):
        row = store.get(entry_id)
        if not row:
            raise HTTPException(404)
        return row

    @app.patch("/api/entries/{entry_id}", **api)
    def entry_update(entry_id: int, body: dict):
        if not store.get(entry_id):
            raise HTTPException(404)
        store.update(entry_id, **body)
        return store.get(entry_id)

    @app.delete("/api/entries/{entry_id}", **api)
    def entry_delete(entry_id: int):
        store.delete(entry_id)
        return {"ok": True}

    @app.delete("/api/entries", **api)
    def entries_clear():
        store.clear()
        return {"ok": True}

    @app.post("/api/entries/{entry_id}/reclean", **api)
    def reclean(entry_id: int, body: dict | None = None):
        row = store.get(entry_id)
        if not row:
            raise HTTPException(404)
        body = body or {}
        if row["kind"] == "note":
            template = body.get("style") or row["style"]
            md = notes.build_note(row["raw"], template, prov())
            store.update(entry_id, cleaned=md, style=template, title=notes.note_title(md), flags="")
        else:
            style = body.get("style") or row["style"]
            cleaned, used, flags = cleanup.clean(row["raw"], style, store.dictionary(), row["app"], provider=prov())
            store.update(entry_id, cleaned=cleaned, style=style, provider=used, flags=flags)
        return store.get(entry_id)

    @app.get("/api/export/{entry_id}", **api)
    def export(entry_id: int):
        row = store.get(entry_id)
        if not row:
            raise HTTPException(404)
        return PlainTextResponse(row["cleaned"], headers={"content-disposition": f'attachment; filename="echoflow-{entry_id}.md"'})

    # ------------------------------------------------------------ settings and dictionary
    @app.get("/api/settings", **api)
    def get_settings():
        return store.settings()

    @app.put("/api/settings", **api)
    def put_settings(body: dict):
        store.set_settings(body)
        return store.settings()

    @app.get("/api/dictionary", **api)
    def get_dictionary():
        return store.dictionary()

    @app.post("/api/dictionary", **api)
    def add_dictionary(body: dict):
        if body.get("term"):
            store.add_term(body["term"])
        if body.get("src") and body.get("dst"):
            store.add_replacement(body["src"], body["dst"])
        return store.dictionary()

    @app.delete("/api/dictionary", **api)
    def del_dictionary(term: str = "", src: str = ""):
        if term:
            store.remove_term(term)
        if src:
            store.remove_replacement(src)
        return store.dictionary()

    if ui_dir and Path(ui_dir).is_dir():
        app.mount("/", StaticFiles(directory=str(ui_dir), html=True), name="ui")
    return app
