"""API keys live outside the database. On Windows they are encrypted with DPAPI (tied to the user account)."""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path


def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    src = Blob(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char)))
    out = Blob()
    fn = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out))
    if not ok:
        raise OSError("DPAPI call failed")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


class SecretStore:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _load(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def get(self, name: str) -> str:
        raw = self._load().get(name)
        if not raw:
            return ""
        blob = base64.b64decode(raw)
        try:
            return (_dpapi(blob, False) if sys.platform == "win32" else blob).decode("utf-8")
        except Exception:
            return ""

    def set(self, name: str, value: str) -> None:
        data = self._load()
        if value:
            blob = value.encode("utf-8")
            if sys.platform == "win32":
                blob = _dpapi(blob, True)
            data[name] = base64.b64encode(blob).decode("ascii")
        else:
            data.pop(name, None)
        self.path.write_text(json.dumps(data), encoding="utf-8")
        if sys.platform != "win32":
            os.chmod(self.path, 0o600)

    def has(self, name: str) -> bool:
        return bool(self.get(name))
