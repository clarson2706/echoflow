import numpy as np
import pytest
from fastapi.testclient import TestClient

from echoflow_engine.db import Store
from echoflow_engine.server import create_app

SR = 16000
H = {"x-echo-token": "t0k"}


class FakeTx:
    ready, loading, error = True, False, ""
    info = {"device": "cpu", "model": "fake"}

    def __init__(self, text="um send 25 invoices to Sam"):
        self.text, self.n = text, 0

    def run(self, pcm, prompt="", beam=1):
        self.n += 1
        return self.text, [{"start": 0, "end": 1, "text": self.text}]


def speech(seconds=1.0):
    t = np.arange(int(seconds * SR)) / SR
    return (0.2 * np.sin(2 * np.pi * 200 * t)).astype(np.float32).tobytes()


@pytest.fixture
def env(tmp_path):
    store, tx = Store(tmp_path / "e.db"), FakeTx()
    client = TestClient(create_app(store, tx, "t0k", None, tmp_path))
    return client, store, tx


def test_requires_token(env):
    client, *_ = env
    assert client.get("/api/health").status_code == 401
    assert client.get("/api/health", headers=H).json()["ready"] is True


def test_dictate_stores_entry(env):
    client, store, _ = env
    r = client.post("/api/dictate?app_name=Gmail", content=speech(), headers=H).json()
    assert r["cleaned"] == "Send 25 invoices to Sam." or r["cleaned"].startswith("Send 25 invoices")
    assert r["style"] == "email"          # picked from the app
    assert store.get(r["id"])["raw"] == "um send 25 invoices to Sam"
    assert client.get("/api/entries?q=invoices", headers=H).json()[0]["id"] == r["id"]


def test_silent_audio_stores_nothing_and_skips_transcription(env):
    client, store, tx = env
    r = client.post("/api/dictate", content=np.zeros(SR, np.float32).tobytes(), headers=H).json()
    assert r == {"empty": True}
    assert tx.n == 0 and store.search("") == []
    short = client.post("/api/dictate", content=speech(0.1), headers=H).json()
    assert short == {"empty": True}


def test_dont_save_text_setting(env):
    client, store, _ = env
    client.put("/api/settings", json={"keep_text": False}, headers=H)
    r = client.post("/api/dictate", content=speech(), headers=H).json()
    assert r["cleaned"] and r["id"] is None and store.search("") == []


def test_reclean_changes_style(env):
    client, store, _ = env
    r = client.post("/api/dictate", content=speech(), headers=H).json()
    out = client.post(f"/api/entries/{r['id']}/reclean", json={"style": "bullets"}, headers=H).json()
    assert out["cleaned"].startswith("- ") and out["style"] == "bullets"


def test_settings_never_return_keys(env):
    client, store, _ = env
    got = client.put("/api/settings", json={"gemini_key": "SECRET-KEY"}, headers=H).json()
    assert got["gemini_key"] == "set"
    assert "SECRET-KEY" not in client.get("/api/settings", headers=H).text


def test_note_session_roundtrip(env):
    client, store, tx = env
    tx.text = "We need to send the deck to Priya by Friday. The budget is 25000 dollars."
    assert client.post("/api/notes/start", json={"template": "meeting"}, headers=H).status_code == 200
    assert client.post("/api/notes/start", json={}, headers=H).status_code == 409
    for _ in range(3):
        client.post("/api/notes/chunk", content=speech(8), headers=H)
    live = client.get("/api/notes/live", headers=H).json()
    assert live["active"] and live["seconds"] == pytest.approx(24, abs=0.1) and live["transcript"]
    done = client.post("/api/notes/finish", headers=H).json()
    assert not done["empty"]
    assert "## Action items" in done["entry"]["cleaned"] and "25000" in done["entry"]["cleaned"]
    assert done["entry"]["kind"] == "note"
    assert client.get("/api/notes/live", headers=H).json() == {"active": False}


def test_dictionary_endpoints(env):
    client, *_ = env
    client.post("/api/dictionary", json={"term": "Anthropic"}, headers=H)
    client.post("/api/dictionary", json={"src": "e flow", "dst": "EchoFlow"}, headers=H)
    d = client.get("/api/dictionary", headers=H).json()
    assert d["terms"] == ["Anthropic"] and d["replacements"] == {"e flow": "EchoFlow"}
    client.delete("/api/dictionary?term=Anthropic", headers=H)
    assert client.get("/api/dictionary", headers=H).json()["terms"] == []


def test_interrupted_note_is_recovered_on_startup(tmp_path):
    from echoflow_engine import notes
    (tmp_path / "note-recovery.json").write_text('{"parts": ["We met Priya about the 25000 budget."]}')
    store = Store(tmp_path / "e.db")
    create_app(store, FakeTx(), "t0k", None, tmp_path)
    rows = store.search("", kind="note")
    assert len(rows) == 1 and "recovered" in rows[0]["flags"] and "25000" in rows[0]["cleaned"]
    assert not (tmp_path / "note-recovery.json").exists()
