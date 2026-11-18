"""Note mode: continuous chunked transcription of a long session, then one structured note."""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

import numpy as np

from .cleanup import rule_clean
from .transcribe import SR, quiet_cut
from .verify import facts_preserved

CHUNK_SECONDS = 15
TAIL_SEARCH = 5  # look for the quietest point in the last N seconds of the buffer
PAUSE_SECONDS = 0.8   # this much silence at the end of the buffer counts as a pause...
MIN_PAUSE_CUT = 5     # ...once at least this many seconds are buffered


class NoteSession:
    def __init__(self, transcriber, recovery_path: Path, prompt: str = ""):
        self.tx = transcriber
        self.recovery = Path(recovery_path)
        self.prompt = prompt
        self.buf = np.zeros(0, np.float32)
        self.parts: list[str] = []
        self.samples = 0
        self.lock = threading.Lock()
        self.finished = False

    @property
    def seconds(self) -> float:
        return self.samples / SR

    def append(self, pcm: np.ndarray) -> None:
        with self.lock:
            self.samples += len(pcm)
            self.buf = np.concatenate([self.buf, pcm])
            while len(self.buf) >= CHUNK_SECONDS * SR:
                lo = max(SR, len(self.buf) - TAIL_SEARCH * SR)
                cut = quiet_cut(self.buf, lo, len(self.buf) - SR // 2)
                self._transcribe(self.buf[:cut])
                self.buf = self.buf[cut:]
            # a natural pause after a few seconds of audio: transcribe now so the live text keeps up
            tail = self.buf[-int(PAUSE_SECONDS * SR):]
            if len(self.buf) >= MIN_PAUSE_CUT * SR and len(tail) >= PAUSE_SECONDS * SR \
                    and float(np.sqrt(np.mean(np.square(tail)))) < 0.004:
                self._transcribe(self.buf)
                self.buf = np.zeros(0, np.float32)

    def _transcribe(self, pcm: np.ndarray) -> None:
        text, _ = self.tx.run(pcm, prompt=self.prompt, beam=1)
        if text:
            self.parts.append(text)
            self.recovery.write_text(json.dumps({"parts": self.parts}), encoding="utf-8")

    def transcript(self) -> str:
        return " ".join(self.parts)

    def finish(self) -> str:
        with self.lock:
            if len(self.buf):
                self._transcribe(self.buf)
                self.buf = np.zeros(0, np.float32)
            self.finished = True
            return self.transcript()

    def close(self) -> None:
        self.recovery.unlink(missing_ok=True)


def recover(path: Path) -> str:
    try:
        return " ".join(json.loads(Path(path).read_text(encoding="utf-8"))["parts"])
    except Exception:
        return ""


# ---------------------------------------------------------------- note writing
ACTION = re.compile(r"\b(?:need to|needs to|have to|has to|should|must|will|remind|follow up|to-?do|action item|"
                    r"don'?t forget|make sure|let'?s)\b", re.I)
KEY = re.compile(r"\b(?:key|important|main|critical|risk|decid(?:ed|e)|agree(?:d)?|deadline|goal|problem|"
                 r"remember|priority|because)\b|\d", re.I)


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def _rule_note(transcript: str) -> str:
    text = rule_clean(transcript, "clean", {"terms": [], "replacements": {}})
    sents = _sentences(text)
    if not sents:
        return ""
    first = sents[0].rstrip(".!?")
    title = first if len(first) <= 60 else first[:57].rsplit(" ", 1)[0] + "..."
    lines = [f"# {title}", "", "## Summary", " ".join(sents[:3])]
    if len(sents) > 3:  # a short note is fully covered by its summary
        lines += ["", "## Notes"] + [f"- {s}" for s in sents[3:]]
    actions = [s for s in sents if ACTION.search(s)]
    key = [s for s in sents if KEY.search(s) and s not in actions] if len(sents) > 3 else []
    if key:
        lines += ["", "## Key points"] + [f"- {s}" for s in key[:8]]
    if actions:
        lines += ["", "## Action items"] + [f"- [ ] {s}" for s in actions]
    return "\n".join(lines)


def build_note(transcript: str, template: str, provider) -> str:
    if not transcript.strip():
        return ""
    if provider is not None and hasattr(provider, "note"):
        out = provider.note(transcript, template)
        if out and facts_preserved(transcript, out):
            return out.strip()
    return _rule_note(transcript)


def note_title(markdown: str) -> str:
    m = re.match(r"#\s+(.+)", markdown)
    return m.group(1).strip() if m else "Untitled note"
