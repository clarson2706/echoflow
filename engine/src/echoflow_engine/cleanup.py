"""Cleanup: rule-based text tidying (always available) plus the orchestration around model providers."""
from __future__ import annotations

import re

from .verify import facts_preserved

STYLES = ("clean", "bullets", "todo", "email", "message")

FILLER = re.compile(r"\b(?:um+|uh+|uhm+|erm+|er|ah|hmm+|mm+)\b[,.]?\s*", re.I)
YOU_KNOW = re.compile(r"\byou know,\s*", re.I)
STUTTER_WORDS = {"the", "a", "an", "to", "of", "and", "i", "we", "you", "it", "is", "in", "on", "for", "this",
                 "so", "but", "my", "our", "your", "with", "be"}
STUTTER = re.compile(r"\b(\w+)(?:\s+\1\b)+", re.I)
NEWLINE_CMD = re.compile(r"[.,]?\s*\bnew (paragraph|line)\b[.,]?\s*", re.I)
SCRATCH = re.compile(r"[,.]?\s*\b(?:scratch that|never mind that|ignore that)\b[.,]?\s*", re.I)
MARKER_STRONG = re.compile(r",\s*(?:i mean|or rather|sorry|no,? wait|wait,? no)\s*,?\s+(?=\S)", re.I)
MARKER_NO = re.compile(r",\s*no\s*,\s*(?=\S)", re.I)
NUMWORD_RE = re.compile(r"^(?:\d[\d.,:]*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
                        r"twenty|thirty|forty|fifty|hundred)$", re.I)
TODO_PREFIX = re.compile(r"^(?:i (?:need|have|got) to|remind me to|don'?t forget to|do not forget to|i should|"
                         r"we need to|i must)\s+", re.I)


def _word(tok: str) -> str:
    return tok.strip(".,!?;:\"'")


def _same_shape(a: str, b: str) -> bool:
    a, b = _word(a), _word(b)
    if NUMWORD_RE.match(a) and NUMWORD_RE.match(b):
        return True
    return a[:1].isupper() and b[:1].isupper()


def _apply_correction(text: str, m: re.Match) -> str:
    before, after = text[:m.start()], text[m.end():]
    end = re.search(r"[.!?]", after)
    corr, rest = (after[:end.start()], after[end.start():]) if end else (after, "")
    btoks, ctoks = before.split(), corr.split()
    if not btoks or not ctoks:
        return text
    first = _word(ctoks[0]).lower()
    cut = len(btoks) - 1
    for p in range(max(0, len(btoks) - 4), len(btoks)):
        if _word(btoks[p]).lower() == first:
            cut = p
            break
    return " ".join(btoks[:cut] + ctoks) + rest


def _corrections(text: str) -> str:
    for _ in range(5):
        m = MARKER_STRONG.search(text)
        if not m:
            m2 = MARKER_NO.search(text)
            if not m2:
                break
            btoks, atoks = text[:m2.start()].split(), text[m2.end():].split()
            if not btoks or not atoks or not _same_shape(btoks[-1], atoks[0]):
                break  # not a correction ("I said, no, to it")
            m = m2
        text = _apply_correction(text, m)
    m = SCRATCH.search(text)
    while m:
        before = text[:m.start()].rstrip(" ,.")
        idx = max(before.rfind(". "), before.rfind("! "), before.rfind("? "))
        before = before[:idx + 1] if idx >= 0 else ""
        text = (before + " " + text[m.end():]).strip()
        m = SCRATCH.search(text)
    return text


def _capitalize(text: str) -> str:
    text = re.sub(r"\bi\b", "I", text)
    text = re.sub(r"(^|[.!?]\s+|\n+\s*)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)
    return text


def _apply_dictionary(text: str, d: dict) -> str:
    for src, dst in d.get("replacements", {}).items():
        text = re.sub(rf"\b{re.escape(src)}\b", lambda _m, dst=dst: dst, text, flags=re.I)
    for term in d.get("terms", []):
        text = re.sub(rf"\b{re.escape(term)}\b", lambda _m, term=term: term, text, flags=re.I)
    return text


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def rule_clean(raw: str, style: str, dictionary: dict) -> str:
    text = " ".join(raw.split())
    if not text:
        return ""
    text = YOU_KNOW.sub("", text)
    text = FILLER.sub("", text)
    text = STUTTER.sub(lambda m: m.group(1) if m.group(1).lower() in STUTTER_WORDS else m.group(0), text)
    text = _corrections(text)
    text = NEWLINE_CMD.sub(lambda m: "\n\n" if m.group(1).lower() == "paragraph" else "\n", text)
    text = re.sub(r"[ \t]*\n[ \t]*", lambda m: "\n", text)
    text = re.sub(r"\s+([,.!?;:])", r"\1", text).strip(" ,")
    text = _capitalize(text)
    if text and text[-1] not in ".!?:\n":
        text += "."
    text = _apply_dictionary(text, dictionary)

    if style == "bullets":
        return "\n".join("- " + s for s in _sentences(text))
    if style == "todo":
        items = []
        for s in _sentences(text):
            s = TODO_PREFIX.sub("", s)
            items.append("- [ ] " + s[:1].upper() + s[1:])
        return "\n".join(items)
    if style == "email":
        sents = _sentences(text)
        if len(sents) > 4 and "\n" not in text:
            return "\n\n".join(" ".join(sents[i:i + 3]) for i in range(0, len(sents), 3))
    if style == "message":
        sents = _sentences(text)
        if len(sents) == 1 and "\n" not in text and text.endswith("."):
            return text[:-1]
    return text


def resolve_style(settings: dict, app: str) -> str:
    style = settings.get("style", "auto")
    if style != "auto":
        return style
    name = (app or "").lower()
    for key, val in settings.get("app_styles", {}).items():
        if key in name:
            return val
    return "clean"


def clean(raw: str, style: str, dictionary: dict, app: str, provider=None) -> tuple[str, str, str]:
    """Returns (text, provider_used, flags). Falls back to rule-based text if the provider is down or
    its output fails the fact check."""
    ruled = rule_clean(raw, style, dictionary)
    if provider is None or not ruled:
        return ruled, "rules", ""
    out = provider.clean(raw, style, dictionary, app)
    if not out:
        return ruled, "rules", "fallback"
    if not facts_preserved(raw, out):
        return ruled, "rules", "fact-check"
    return out.strip(), provider.name, ""
