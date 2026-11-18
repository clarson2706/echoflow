import numpy as np

from echoflow_engine import notes
from echoflow_engine.transcribe import SR


class FakeTx:
    def __init__(self):
        self.calls = []

    def run(self, pcm, prompt="", beam=1):
        self.calls.append(len(pcm))
        return f"chunk {len(self.calls)} text.", [{"start": 0, "end": 1, "text": "x"}]


def tone(seconds, amp=0.1):
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def test_session_transcribes_in_chunks_and_finishes(tmp_path):
    tx = FakeTx()
    s = notes.NoteSession(tx, tmp_path / "rec.json")
    for _ in range(5):
        s.append(tone(8))             # 40 s of audio arrives in 8 s pieces
    assert len(tx.calls) >= 2          # cut at least twice while recording
    assert all(c < 20 * SR for c in tx.calls)
    s.finish()
    assert abs(s.seconds - 40) < 0.1
    assert "chunk 1 text." in s.transcript()
    assert sum(tx.calls) <= 40 * SR + 10  # no audio transcribed twice


def test_cut_prefers_quiet_point(tmp_path):
    tx = FakeTx()
    s = notes.NoteSession(tx, tmp_path / "rec.json")
    audio = np.concatenate([tone(13), np.zeros(int(0.6 * SR), np.float32), tone(4)])  # gap at 13.0-13.6 s
    s.append(audio)
    cut_seconds = tx.calls[0] / SR
    assert 13.0 < cut_seconds < 13.6  # inside the silent gap, not mid-tone


def test_cuts_at_a_pause_without_waiting_for_a_full_chunk(tmp_path):
    tx = FakeTx()
    s = notes.NoteSession(tx, tmp_path / "rec.json")
    s.append(tone(7))
    assert tx.calls == []                       # still talking: keep listening
    s.append(np.zeros(int(0.9 * SR), np.float32))  # a natural pause
    assert len(tx.calls) == 1 and s.transcript() == "chunk 1 text."


def test_recovery_after_restart(tmp_path):
    tx = FakeTx()
    rec = tmp_path / "rec.json"
    s = notes.NoteSession(tx, rec)
    s.append(tone(20))
    assert notes.recover(rec).startswith("chunk 1 text.")
    s.finish()
    s.close()
    assert notes.recover(rec) == ""  # deleted when the session ends normally


def test_rule_based_note():
    transcript = ("Today we talked about the launch plan. The launch date is March 5th. "
                  "We need to send the deck to Priya by Friday. The budget is 25000 dollars. "
                  "Sam should book the venue. The key risk is the vendor delay.")
    md = notes.build_note(transcript, "meeting", provider=None)
    assert md.startswith("# ")
    assert "## Summary" in md
    assert "## Action items" in md
    assert "- [ ] We need to send the deck to Priya by Friday." in md
    assert "- [ ] Sam should book the venue." in md
    assert "25000" in md and "March 5th" in md


def test_empty_transcript_gives_empty_note():
    assert notes.build_note("   ", "meeting", provider=None) == ""


def test_provider_note_rejected_if_facts_lost():
    class P:
        name = "fake"
        def note(self, t, template):
            return "# Plan\n\n## Summary\nWe met."

    md = notes.build_note("We agreed to spend 25000 dollars with Priya.", "meeting", provider=P())
    assert "25000" in md  # fell back to the rule-based note
