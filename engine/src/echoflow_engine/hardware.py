"""Hardware detection and model choice. Adapted from Murmur (MIT, same author)."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


CUDA_PINS = ["nvidia-cublas-cu12==12.8.4.1", "nvidia-cudnn-cu12>=9,<10"]
_cuda_dir: Path | None = None


def set_cuda_dir(path: str | Path) -> None:
    """Folder the first-run download puts the GPU libraries in (inside the user's data directory)."""
    global _cuda_dir
    _cuda_dir = Path(path)


def cuda_libs_present() -> bool:
    import importlib
    import importlib.util
    importlib.invalidate_caches()
    if _cuda_dir and _cuda_dir.is_dir() and str(_cuda_dir) not in sys.path:
        sys.path.insert(0, str(_cuda_dir))
    spec = importlib.util.find_spec("nvidia")
    if not spec or not spec.submodule_search_locations:
        return False
    return any(list(Path(p).glob("cublas/bin/*.dll")) or list(Path(p).glob("cublas/lib/libcublas*"))
               for p in spec.submodule_search_locations)


def install_cuda_libs() -> bool:
    """pip-install cuBLAS and cuDNN (about 1.2 GB, once) so no system CUDA install is needed."""
    if not _cuda_dir:
        return False
    _cuda_dir.mkdir(parents=True, exist_ok=True)
    try:
        r = subprocess.run([sys.executable, "-m", "pip", "install", "--target", str(_cuda_dir), "--upgrade",
                            "--no-warn-script-location", "--disable-pip-version-check", *CUDA_PINS],
                           capture_output=True, text=True, timeout=3600)
        return r.returncode == 0 and cuda_libs_present()
    except Exception:
        return False


def register_cuda_libs() -> None:
    """Make pip-installed cuBLAS / cuDNN loadable, so no system CUDA install is needed."""
    import importlib
    import importlib.util
    importlib.invalidate_caches()
    if _cuda_dir and _cuda_dir.is_dir() and str(_cuda_dir) not in sys.path:
        sys.path.insert(0, str(_cuda_dir))
    spec = importlib.util.find_spec("nvidia")
    if not spec or not spec.submodule_search_locations:
        return
    roots = [Path(p) for p in spec.submodule_search_locations]
    if os.name == "nt":
        for bin_dir in (d for r in roots for d in r.glob("*/bin")):
            os.add_dll_directory(str(bin_dir))
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
    elif sys.platform.startswith("linux"):
        import ctypes
        libs = sorted(f for r in roots for f in r.glob("*/lib/lib*.so*")
                      if f.name.startswith(("libcublas", "libcudnn")))
        for _ in range(2):
            for f in libs:
                try:
                    ctypes.CDLL(str(f), mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


def gpu_info() -> tuple[str, float] | None:
    """(name, total VRAM in GB) of the first NVIDIA GPU, via nvidia-smi."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
        name, mem = out[0].rsplit(",", 1)
        return name.strip(), float(mem) / 1024
    except Exception:
        return None


def detect(requested_model: str = "auto", force_cpu: bool = False) -> dict:
    """What the engine will run on, and why."""
    gpu = None if force_cpu else gpu_info()
    cuda_ok = False
    if gpu:
        register_cuda_libs()
        try:
            import ctranslate2
            cuda_ok = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            cuda_ok = False
    device = "cuda" if cuda_ok else "cpu"
    if requested_model and requested_model != "auto":
        model = requested_model
    else:
        model = "large-v3-turbo" if device == "cuda" else "small.en"
    reason = (f"{gpu[0]} ({gpu[1]:.0f} GB) detected: using the GPU." if cuda_ok else
              "No usable NVIDIA GPU found: using the CPU with a smaller model (slower)." if not gpu else
              "GPU found but CUDA libraries failed to load: using the CPU.")
    return {"device": device, "model": model, "gpu": gpu[0] if gpu else None,
            "vram_gb": round(gpu[1], 1) if gpu else None, "cpu_threads": os.cpu_count() or 4, "reason": reason}
