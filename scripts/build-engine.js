// Builds engine-dist/python: a self-contained Python 3.12 with the EchoFlow engine and its dependencies
// installed (no GPU libraries; the app downloads those on first run). Run before electron-builder.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "engine-dist");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1. a relocatable CPython from uv's standalone builds
const install = path.join(dist, "_py");
run("uv", ["python", "install", "3.12", "--install-dir", install, "--no-bin"]);
// uv also leaves a junction named cpython-3.12-...; take the real folder (full version number, not a link)
const found = fs.readdirSync(install).find((d) => /^cpython-3\.12\.\d+/.test(d) && !fs.lstatSync(path.join(install, d)).isSymbolicLink());
if (!found) throw new Error("uv did not install Python 3.12");
const python = path.join(dist, "python");
fs.renameSync(path.join(install, found), python);
fs.rmSync(install, { recursive: true, force: true });
const exe = path.join(python, "python.exe");
// uv marks its Pythons "externally managed"; this copy is ours, and the app pip-installs GPU libraries into it later
fs.rmSync(path.join(python, "Lib", "EXTERNALLY-MANAGED"), { force: true });

// 2. the engine and its dependencies, installed into that Python with its own pip
run(exe, ["-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check", "--compile", path.join(root, "engine")]);

// 3. trim what a user never needs
const site = path.join(python, "Lib", "site-packages");
const drop = [path.join(python, "Lib", "test"), path.join(python, "Lib", "idlelib"), path.join(python, "Lib", "tkinter"),
  path.join(python, "tcl"), path.join(python, "Doc"), path.join(python, "include"), path.join(python, "libs")];
for (const d of drop) fs.rmSync(d, { recursive: true, force: true });
(function prune(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === "tests" || e.name === "test") { if (dir.startsWith(site)) fs.rmSync(p, { recursive: true, force: true }); } else prune(p); }
  }
})(site);

// 4. prove it starts, and is free of GPU libraries
const check = execFileSync(exe, ["-c", "import echoflow_engine, faster_whisper, fastapi, uvicorn, httpx, ctranslate2; import importlib.util as u; print('ok', echoflow_engine.__version__, 'nvidia' if u.find_spec('nvidia') else 'no-nvidia')"], { encoding: "utf8" }).trim();
console.log("engine bundle:", check);
if (!check.startsWith("ok")) process.exit(1);
