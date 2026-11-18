// EchoFlow shell: tray, hotkeys, overlay pill, audio capture, paste, dashboard window.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, session, desktopCapturer, screen, Notification, clipboard } = require("electron");
const path = require("path");
const { Engine } = require("./engine");
const { Hotkeys } = require("./hotkey");
const { insertText } = require("./insert");
const { foreground } = require("./foreground");
const { Updater } = require("./updater");

const TEST = !!process.env.ECHOFLOW_TEST;
if (process.env.ECHOFLOW_FAKE_AUDIO) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", process.env.ECHOFLOW_FAKE_AUDIO);
}
if (!app.requestSingleInstanceLock() && !TEST) { app.quit(); }

const dataDir = process.env.ECHOFLOW_DATA_DIR || path.join(app.getPath("userData"), "data");
const engine = new Engine(dataDir);
const hotkeys = new Hotkeys();
const updater = new Updater();
let win, overlay, captureWin, tray, testField;
let settings = null;
let recording = false, noteActive = false, quitting = false, busy = false;
let capReady = null, capDone = null, noteChunks = Promise.resolve();

const log = (...a) => process.env.ECHOFLOW_DEBUG && console.log("[shell]", ...a);

// ---------------------------------------------------------------- windows
function createMain() {
  win = new BrowserWindow({
    width: 1320, height: 840, minWidth: 760, minHeight: 560, show: false, backgroundColor: "#f7f2e6",
    title: "EchoFlow", icon: path.join(__dirname, "..", "assets", "icon.png"), autoHideMenuBar: true,
    titleBarStyle: "hidden", titleBarOverlay: { color: "#00000000", symbolColor: "#2d4538", height: 38 },
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.loadURL(engine.uiUrl);
  win.once("ready-to-show", () => { if (!process.argv.includes("--hidden")) win.show(); });
  win.on("close", (e) => { if (!quitting && !TEST) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function showMain(view) {
  if (!win) return;
  win.show(); win.focus();
  if (view) win.webContents.send("navigate", view);
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: 260, height: 76, show: false, frame: false, transparent: true, resizable: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true);
  overlay.loadFile(path.join(__dirname, "overlay.html"));
}
let overlayHide = null;
function pill(state, text, autoHideMs) {
  if (!overlay) return;
  clearTimeout(overlayHide);
  if (state === "hidden") { overlay.webContents.send("overlay:state", "hidden"); overlayHide = setTimeout(() => overlay.hide(), 200); return; }
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  overlay.setPosition(Math.round(d.x + d.width / 2 - 130), Math.round(d.y + d.height - 110));
  overlay.showInactive();
  overlay.webContents.send("overlay:state", state, text);
  if (autoHideMs) overlayHide = setTimeout(() => pill("hidden"), autoHideMs);
}

function createCapture() {
  captureWin = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  captureWin.loadFile(path.join(__dirname, "capture.html"));
}

// ---------------------------------------------------------------- audio capture plumbing
ipcMain.on("cap:ready", (_e, r) => capReady && capReady(r));
ipcMain.on("cap:done", (_e, buf) => capDone && capDone(Buffer.from(buf)));
ipcMain.on("cap:level", (_e, rms) => { if (overlay && recording) overlay.webContents.send("overlay:level", rms); });
ipcMain.on("cap:chunk", (_e, buf) => {
  if (!noteActive) return;
  const body = Buffer.from(buf);
  noteChunks = noteChunks.then(() => engine.api("/notes/chunk", { method: "POST", raw: body })).catch((e) => log("chunk failed", e.message));
});

function capStart(opts) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: "Microphone did not start." }), 8000);
    capReady = (r) => { clearTimeout(t); resolve(r); };
    captureWin.webContents.send("cap:start", opts);
  });
}
function capStop() {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(Buffer.alloc(0)), 5000);
    capDone = (b) => { clearTimeout(t); resolve(b); };
    captureWin.webContents.send("cap:stop");
  });
}

// ---------------------------------------------------------------- dictation
let startPromise = null;
async function dictationDown() {
  if (recording || busy) return;
  if (noteActive) { pill("error", "Note in progress", 1600); return; }
  recording = true;
  const target = foreground(Object.keys(settings.app_styles || {}));
  dictationDown.target = target; log("dictation down, foreground:", JSON.stringify(target));
  startPromise = capStart({ mic: true, system: false, mode: "dictate" });
  pill("listening");
  const r = await startPromise;
  if (!r.ok) { recording = false; pill("error", r.error || "Microphone unavailable", 2400); }
}

async function dictationUp() {
  if (!recording) return;
  recording = false; busy = true;
  try {
    const r = await startPromise;
    if (!r || !r.ok) return;
    const pcm = await capStop();
    if (pcm.length < 16000 * 4 * 0.25) { pill("hidden"); return; } // under a quarter second
    pill("thinking");
    const out = await engine.api("/dictate", { method: "POST", raw: pcm, query: { app_name: dictationDown.target?.label || "" } });
    if (out.empty) { pill("error", "Nothing heard", 1400); return; }
    const res = await insertText(out.cleaned);
    log("insert", JSON.stringify(res), JSON.stringify(out.cleaned), "foreground now:", JSON.stringify(foreground([])));
    if (res.ok) pill("done", "Inserted", 900);
    else pill("error", "Copied. Press Ctrl+V", 2600);
    if (TEST && testField) testField.webContents.send("inserted", out);
  } catch (e) {
    log("dictation failed", e.message);
    pill("error", e.message.includes("503") ? "Still loading the model" : "Engine not responding", 2400);
  } finally { busy = false; }
}

// ---------------------------------------------------------------- note mode
async function noteStart() {
  if (noteActive) return { ok: true };
  if (recording || busy) return { ok: false, error: "Finish dictating first." };
  const sources = settings.note_sources;
  try { await engine.api("/notes/start", { method: "POST", body: { template: settings.note_template } }); }
  catch (e) { return { ok: false, error: e.message.includes("503") ? "Model is still loading" : "Could not start" }; }
  const r = await capStart({ mic: sources !== "system", system: sources !== "mic", mode: "note" });
  if (!r.ok) { await engine.api("/notes/cancel", { method: "POST" }).catch(() => {}); return { ok: false, error: r.error }; }
  noteActive = true; noteChunks = Promise.resolve();
  updateTray();
  return { ok: true };
}

async function noteFinish() {
  if (!noteActive) return { empty: true };
  const tail = await capStop();
  if (tail.length) noteChunks = noteChunks.then(() => engine.api("/notes/chunk", { method: "POST", raw: tail })).catch(() => {});
  await noteChunks;
  noteActive = false; updateTray();
  const r = await engine.api("/notes/finish", { method: "POST" });
  if (!r.empty) new Notification({ title: "Note saved", body: r.entry.title }).show();
  return r;
}

async function noteCancel() {
  if (!noteActive) return { ok: true };
  await capStop(); noteActive = false; updateTray();
  await engine.api("/notes/cancel", { method: "POST" }).catch(() => {});
  return { ok: true };
}

ipcMain.handle("note:start", noteStart);
ipcMain.handle("note:finish", noteFinish);
ipcMain.handle("note:cancel", noteCancel);
ipcMain.handle("settings:changed", loadSettings);
ipcMain.handle("update:get", () => updater.state);
ipcMain.handle("update:check", () => updater.check());
ipcMain.handle("update:download", () => updater.download());
ipcMain.handle("update:install", () => { quitting = true; hotkeys.stop(); return updater.install(); });
updater.on("state", (s) => { if (win && !win.isDestroyed()) win.webContents.send("update:state", s); updateTray(); });

async function toggleNote() {
  if (noteActive) { await noteFinish(); showMain("notes"); }
  else { const r = await noteStart(); if (!r.ok) pill("error", r.error, 2200); else showMain("history"); }
}

// ---------------------------------------------------------------- tray
function updateTray() {
  if (!tray) return;
  const key = settings ? settings.hotkey.replace("Control", "Ctrl") : "Ctrl+Space";
  tray.setToolTip(noteActive ? "EchoFlow: taking a note" : `EchoFlow: hold ${key} to dictate`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open EchoFlow", click: () => showMain() },
    { label: noteActive ? "Finish note" : "Start note", click: toggleNote },
    ...(updater.state.status === "ready" ? [{ label: `Restart to update to ${updater.state.version}`, click: () => { quitting = true; hotkeys.stop(); updater.install(); } }] : []),
    { label: "Dictation hotkey enabled", type: "checkbox", checked: hotkeys.enabled, click: (i) => { hotkeys.enabled = i.checked; } },
    { type: "separator" },
    { label: "Quit EchoFlow", click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------- settings and hotkeys
async function loadSettings() {
  settings = await engine.api("/settings");
  if (updater.supported && !updater.au) updater.init(settings.auto_update !== false); else updater.setAuto(settings.auto_update !== false);
  const mode = settings.toggle_mode ? "toggle" : "hold";
  let ok = hotkeys.bind("dictate", settings.hotkey, mode === "hold"
    ? { mode, onDown: dictationDown, onUp: dictationUp }
    : { mode, onDown: () => (recording ? dictationUp() : dictationDown()) });
  if (!ok) pill("error", `${settings.hotkey} is taken by another app`, 3000);
  hotkeys.bind("note", settings.note_hotkey, { mode: "toggle", onDown: toggleNote });
  updateTray();
  return true;
}

// ---------------------------------------------------------------- test harness: a focused text field to paste into
function createTestField() {
  testField = new BrowserWindow({ width: 520, height: 260, x: 80, y: 80, title: "EchoFlow test field", show: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  testField.removeMenu();
  testField.loadURL("data:text/html,<title>test field</title><textarea id=t style='width:96%25;height:180px'></textarea><script>window.keys=[];addEventListener('keydown',e=>keys.push(e.key+(e.ctrlKey?'+ctrl':'')));addEventListener('paste',e=>keys.push('PASTE-EVENT'));</script>");
  testField.once("ready-to-show", () => { testField.show(); testField.focus(); });
}

// ---------------------------------------------------------------- boot
app.on("second-instance", () => showMain());
app.on("window-all-closed", () => {});
app.on("before-quit", () => { quitting = true; hotkeys.stop(); engine.stop(); });

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((sources) => cb({ video: sources[0], audio: "loopback" })).catch(() => cb({}));
  });

  try { await engine.start(); }
  catch (e) {
    const { dialog } = require("electron");
    dialog.showErrorBox("EchoFlow could not start its engine", String(e.message));
    app.quit(); return;
  }
  engine.on("down", () => pill("error", "Engine restarting", 2000));
  engine.on("up", () => { if (win && !win.isDestroyed()) win.loadURL(engine.uiUrl); loadSettings().catch(() => {}); });

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray.png")));
  tray.on("click", () => showMain());
  createCapture(); createOverlay(); createMain();
  hotkeys.start();
  await loadSettings();
  if (TEST) createTestField();
  if (settings.launch_at_login !== undefined) app.setLoginItemSettings({ openAtLogin: !!settings.launch_at_login, args: ["--hidden"] });
  if (TEST) global.__echo = { engine, win, getState: () => ({ recording, busy, noteActive }) };
});
