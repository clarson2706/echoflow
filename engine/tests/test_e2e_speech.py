"""Real model, real (synthesized) speech. Skipped when the model is not downloaded or the fixture is missing.
Regenerate the fixture with Windows' built-in voice (System.Speech) if needed."""
import time
from pathlib import Path

import pytest

from echoflow_engine import cleanup
from echoflow_engine.transcribe import Transcriber, model_is_cached
from echoflow_engine.verify import facts_preserved

WAV = Path(__file__).parent / "fixtures" / "dictation.wav"


@pytest.fixture(scope="module")
def tx():
    t = Transcriber()
    if not WAV.exists() or not model_is_cached(t.info["model"]):
        pytest.skip("speech fixture or model not available")
    t.load()
    assert t.ready, t.error
    return t


def audio():
    from faster_whisper import decode_audio
    return decode_audio(str(WAV), sampling_rate=16000)


def test_real_transcription_and_cleanup(tx):
    pcm = audio()
    tx.run(pcm)  # warm up
    t0 = time.perf_counter()
    raw, _ = tx.run(pcm)
    elapsed = time.perf_counter() - t0
    print(f"\nraw: {raw!r}  ({elapsed:.2f}s for {len(pcm)/16000:.1f}s of speech, {tx.info['device']})")
    low = raw.lower()
    assert "invoices" in low and "sam" in low and "priya" in low
    cleaned, used, flags = cleanup.clean(raw, "clean", {"terms": [], "replacements": {}}, "", provider=None)
    print(f"cleaned: {cleaned!r}")
    assert "um" not in cleaned.lower().split()
    assert cleaned.endswith(".")
    assert elapsed < 3.0
