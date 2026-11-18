"""Whisper transcription of short utterances (dictation) and chunks (note mode)."""
from __future__ import annotations

import os
import threading
import time

import numpy as np

from . import hardware

SR = 16000
MIN_SPEECH_RMS = 0.004  # below this the capture is treated as silence


def is_silent(pcm: np.ndarray) -> bool:
    if pcm.size < SR * 0.25:  # shorter than a quarter second
        return True
    return float(np.sqrt(np.mean(np.square(pcm)))) < MIN_SPEECH_RMS


def model_is_cached(name: str) -> bool:
    try:
        from faster_whisper.utils import download_model
        download_model(name, local_files_only=True)
        return True
    except Exception:
        return False


class Transcriber:
    """Loads Whisper once and keeps it warm. Thread-safe: calls are serialized."""

    def __init__(self, requested_model: str = "auto"):
        self.info = hardware.detect(requested_model)
        self.model = None
        self.lock = threading.Lock()
        self.requested = requested_model
        self.loading = False
        self.error = ""
        self.stage = ""   # gpu-libs | model-download | loading | "" (ready or idle): shown in the dashboard
        self.load_seconds = 0.0

    def load(self) -> None:
        from faster_whisper import WhisperModel
        self.loading = True
        t = time.perf_counter()
        if self.info["device"] == "cuda" and not hardware.cuda_libs_present():
            self.stage = "gpu-libs"           # one-time download of cuBLAS/cuDNN
            if hardware.install_cuda_libs():
                hardware.register_cuda_libs()
            else:                             # offline or blocked: still work, on the CPU
                self.info = hardware.detect(self.requested, force_cpu=True)
                self.info["reason"] = "Could not download the GPU libraries: using the CPU (slower). Restart to retry."
        name, device = self.info["model"], self.info["device"]
        cached = model_is_cached(name)
        self.stage = "loading" if cached else "model-download"

        def build(dev: str):
            ct = "int8_float16" if dev == "cuda" else "int8"
            return WhisperModel(name, device=dev, compute_type=ct, cpu_threads=self.info["cpu_threads"],
                                local_files_only=cached)
        try:
            try:
                self.model = build(device)
            except Exception:
                if device != "cuda":
                    raise
                self.info["device"] = "cpu"
                self.info["reason"] = "GPU failed to load the model: fell back to the CPU."
                self.model = build("cpu")
        except Exception as e:  # keep the engine alive and report it
            self.error = str(e).splitlines()[0][:200]
        finally:
            self.loading = False
            self.stage = ""
            self.load_seconds = time.perf_counter() - t

    @property
    def ready(self) -> bool:
        return self.model is not None

    def run(self, pcm: np.ndarray, prompt: str = "", beam: int = 1) -> tuple[str, list[dict]]:
        """Transcribe 16 kHz mono float32. Returns (text, segments)."""
        if self.model is None:
            raise RuntimeError("model not loaded: " + (self.error or "still loading"))
        if is_silent(pcm):
            return "", []
        with self.lock:
            seg_iter, _ = self.model.transcribe(
                pcm, language="en", beam_size=beam, vad_filter=True, condition_on_previous_text=False,
                initial_prompt=prompt or None, vad_parameters=dict(min_silence_duration_ms=500))
            segs = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in seg_iter]
        text = " ".join(s["text"] for s in segs if s["text"]).strip()
        return text, segs


def quiet_cut(audio: np.ndarray, lo: int, hi: int, window: int = SR // 4) -> int:
    """Sample index inside [lo, hi) at the quietest quarter-second, so a split never cuts a word."""
    seg = audio[lo:hi]
    n = len(seg) // window
    if n < 2:
        return hi
    energy = np.square(seg[: n * window].reshape(n, window)).mean(axis=1)
    return lo + int(energy.argmin()) * window + window // 2
