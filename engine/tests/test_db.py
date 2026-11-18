from echoflow_engine.db import Store


def make(tmp_path):
    return Store(tmp_path / "echo.db")


def test_add_get_and_search(tmp_path):
    s = make(tmp_path)
    a = s.add_entry(kind="dictation", raw="um send the invoice to sam", cleaned="Send the invoice to Sam.",
                    app="Gmail", style="email", duration=3.2)
    s.add_entry(kind="dictation", raw="buy milk", cleaned="Buy milk.", app="Notepad", style="clean")
    assert s.get(a)["cleaned"] == "Send the invoice to Sam."
    hits = s.search("invoice")
    assert [h["id"] for h in hits] == [a]
    assert s.search("sam")[0]["id"] == a  # matches cleaned text, case-insensitive
    assert len(s.search("")) == 2


def test_filters_and_order(tmp_path):
    s = make(tmp_path)
    s.add_entry(kind="dictation", raw="a", cleaned="A", app="X", style="clean")
    n = s.add_entry(kind="note", raw="long talk", cleaned="# Note", app="", style="meeting", title="Marketing")
    rows = s.search("", kind="note")
    assert [r["id"] for r in rows] == [n]
    assert s.search("", app="X")[0]["raw"] == "a"
    assert s.search("")[0]["id"] == n  # newest first


def test_update_delete(tmp_path):
    s = make(tmp_path)
    i = s.add_entry(kind="dictation", raw="hello world", cleaned="Hello world.", app="", style="clean")
    s.update(i, cleaned="Hello, world!")
    assert s.get(i)["cleaned"] == "Hello, world!"
    assert s.search("hello")[0]["id"] == i
    s.delete(i)
    assert s.get(i) is None
    assert s.search("hello") == []


def test_settings_and_dictionary(tmp_path):
    s = make(tmp_path)
    assert s.settings()["hotkey"] == "Control+Space"  # defaults
    s.set_settings({"hotkey": "Control+Alt+D"})
    assert Store(tmp_path / "echo.db").settings()["hotkey"] == "Control+Alt+D"  # persisted
    s.add_term("Anthropic")
    s.add_replacement("claude code", "Claude Code")
    d = s.dictionary()
    assert "Anthropic" in d["terms"]
    assert d["replacements"] == {"claude code": "Claude Code"}
    s.remove_term("Anthropic")
    assert s.dictionary()["terms"] == []


def test_secrets_not_in_database(tmp_path):
    s = make(tmp_path)
    s.set_settings({"gemini_key": "SECRET123"})
    assert "SECRET123" not in (tmp_path / "echo.db").read_bytes().decode("latin-1")
    assert s.secret("gemini_key") == "SECRET123"
    assert s.settings()["gemini_key"] == "set"  # never returned
