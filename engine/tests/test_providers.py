import httpx

from echoflow_engine import providers


class Resp:
    def __init__(self, data, status=200):
        self._d, self.status_code = data, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("bad", request=None, response=None)

    def json(self):
        return self._d


D = {"terms": ["Priya"], "replacements": {}}


def test_gemini_parses_and_sends_context(monkeypatch):
    seen = {}

    def post(url, headers=None, json=None, timeout=None):
        seen.update(url=url, headers=headers, body=json)
        return Resp({"candidates": [{"content": {"parts": [{"text": "  Hello there.  "}]}}]})
    monkeypatch.setattr(httpx, "post", post)
    out = providers.Gemini("KEY", "gemini-2.5-flash").clean("um hello there", "email", D, "Gmail")
    assert out == "Hello there."
    assert "gemini-2.5-flash" in seen["url"] and seen["headers"]["x-goog-api-key"] == "KEY"
    sent = str(seen["body"])
    assert "Gmail" in sent and "Priya" in sent and "um hello there" in sent


def test_openai_compatible_parses(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *a, **k: Resp({"choices": [{"message": {"content": "Hi."}}]}))
    assert providers.OpenAICompatible("k", "http://localhost:11434/v1", "m").clean("hi", "clean", D, "") == "Hi."


def test_any_failure_returns_none(monkeypatch):
    def boom(*a, **k):
        raise httpx.ConnectError("down")
    monkeypatch.setattr(httpx, "post", boom)
    assert providers.Gemini("k", "m").clean("hi", "clean", D, "") is None
    monkeypatch.setattr(httpx, "post", lambda *a, **k: Resp({}, status=429))
    assert providers.OpenAICompatible("k", "http://x/v1", "m").clean("hi", "clean", D, "") is None


def test_get_provider_selection():
    secret = {"gemini_key": "g"}.get
    assert providers.get_provider({"provider": "rules"}, secret) is None
    assert providers.get_provider({"provider": "gemini", "gemini_model": "m"}, secret).name == "gemini"
    assert providers.get_provider({"provider": "gemini"}, {}.get) is None       # no key: rule-based
    assert providers.get_provider({"provider": "openai", "openai_base_url": "http://localhost:11434/v1"}, {}.get).name == "openai"
    assert providers.get_provider({"provider": "openai", "openai_base_url": "https://api.openai.com/v1"}, {}.get) is None
