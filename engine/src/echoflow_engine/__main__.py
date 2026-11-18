"""Run the engine: python -m echoflow_engine --data-dir DIR --token TOKEN [--ui-dir DIR] [--port N]"""
from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
from pathlib import Path


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="echoflow-engine")
    p.add_argument("--data-dir", required=True)
    p.add_argument("--token", required=True)
    p.add_argument("--ui-dir", default="")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--model", default="")
    args = p.parse_args(argv)

    from .db import Store
    from .server import create_app
    from .transcribe import Transcriber
    import uvicorn

    data = Path(args.data_dir)
    data.mkdir(parents=True, exist_ok=True)
    from . import hardware
    hardware.set_cuda_dir(data / "cuda-libs")
    store = Store(data / "echoflow.db")
    tx = Transcriber(args.model or store.settings()["whisper_model"])
    threading.Thread(target=tx.load, daemon=True, name="model-load").start()  # server is up while the model loads

    app = create_app(store, tx, args.token, Path(args.ui_dir) if args.ui_dir else None, data)

    sock = socket.socket()
    sock.bind(("127.0.0.1", args.port))
    sock.listen(128)  # connections made before uvicorn starts accepting simply wait in the backlog
    port = sock.getsockname()[1]
    print(json.dumps({"event": "listening", "port": port}), flush=True)
    uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
