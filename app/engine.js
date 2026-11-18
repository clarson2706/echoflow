// Starts the Python engine, keeps it alive, and wraps its HTTP API.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const ROOT = path.join(__dirname, "..");
const PACKAGED = __dirname.includes("app.asar");
const UI_DIR = PACKAGED ? path.join(process.resourcesPath, "ui") : path.join(ROOT, "ui");

function pythonPath() {
  const candidates = [
    process.env.ECHOFLOW_PYTHON,
    path.join(process.resourcesPath || "", "engine", "python", "python.exe"), // packaged build
    path.join(ROOT, "engine", ".venv", "Scripts", "python.exe"),
    path.join(ROOT, "engine", ".venv", "bin", "python"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

class Engine extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.token = crypto.randomBytes(16).toString("hex");
    this.port = 0;
    this.proc = null;
    this.stopping = false;
    this.restarts = 0;
  }

  get base() { return `http://127.0.0.1:${this.port}`; }
  get uiUrl() { return `${this.base}/?token=${this.token}`; }

  start() {
    return new Promise((resolve, reject) => {
      const py = pythonPath();
      if (!py) return reject(new Error("Python engine not found. Run `uv sync` in the engine folder."));
      const args = ["-m", "echoflow_engine", "--data-dir", this.dataDir, "--token", this.token, "--ui-dir", UI_DIR];
      this.proc = spawn(py, args, { cwd: PACKAGED ? this.dataDir : path.join(ROOT, "engine"), windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", ECHOFLOW_VERSION: require("electron").app.getVersion() } });
      let settled = false, buf = "";
      this.proc.stdout.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.event === "listening") { this.port = msg.port; if (!settled) { settled = true; resolve(); } this.emit("up"); }
          } catch { /* ordinary log line */ }
        }
      });
      this.proc.stderr.on("data", (d) => process.env.ECHOFLOW_DEBUG && process.stderr.write("[engine] " + d));
      this.proc.on("exit", (code) => {
        this.proc = null;
        if (!settled) { settled = true; reject(new Error("engine exited with code " + code)); return; }
        if (!this.stopping) {
          this.emit("down");
          const delay = Math.min(10000, 500 * 2 ** this.restarts++);
          setTimeout(() => this.start().then(() => { this.restarts = 0; }).catch(() => {}), delay);
        }
      });
    });
  }

  stop() {
    this.stopping = true;
    if (this.proc) this.proc.kill();
  }

  async api(p, { method = "GET", body, raw, query } = {}) {
    const url = `${this.base}/api${p}${query ? "?" + new URLSearchParams(query) : ""}`;
    const headers = { "x-echo-token": this.token };
    let payload;
    if (raw) { payload = raw; headers["content-type"] = "application/octet-stream"; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    const res = await fetch(url, { method, headers, body: payload });
    if (!res.ok) throw new Error(`engine ${res.status} on ${p}`);
    return res.json();
  }
}

module.exports = { Engine };
