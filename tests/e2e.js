// End-to-end: the real app, real hotkey events, a (synthesized-speech) fake microphone, real Whisper.
// Run: node tests/e2e.js   (needs the engine venv and the Whisper model; ~1 minute)
const { _electron: electron } = require("playwright");
const { uIOhook, UiohookKey: K } = require("uiohook-napi");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FIX = path.join(ROOT, "engine", "tests", "fixtures");
const OUT = process.env.E2E_SHOTS || path.join(os.tmpdir(), "echoflow-e2e");
fs.mkdirSync(OUT, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), "echoflow-data-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); if (!ok) failures++; };

async function until(fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > end) return null; await sleep(step); }
}

(async () => {
  const env = { ...process.env, ECHOFLOW_DATA_DIR: data, ECHOFLOW_TEST: "1", ECHOFLOW_FAKE_AUDIO: path.join(FIX, "short.wav") };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.E2E_DEBUG) env.ECHOFLOW_DEBUG = "1";
  const EXE = process.env.E2E_EXE; // test the packaged app instead of the source tree
  const app = await electron.launch(EXE ? { executablePath: EXE, args: [], env } : { args: ["."], cwd: ROOT, env });
  if (process.env.E2E_DEBUG) app.process().stdout.on("data", (d) => process.stdout.write("   [app] " + d));
  const page = await until(() => app.windows().find((w) => w.url().includes("127.0.0.1")), 30000);
  check("dashboard window opens", !!page);
  await page.setViewportSize({ width: 1320, height: 840 });
  const api = (p, o) => page.evaluate(async ([p, o]) => { const t = new URLSearchParams(location.search).get("token") || sessionStorage.getItem("echo-token"); const r = await fetch("/api" + p, { ...(o || {}), headers: { "x-echo-token": t, "content-type": "application/json" } }); return r.json(); }, [p, o]);

  let lastStage = "";
  const ready = await until(async () => { const h = await api("/health"); if (h.stage !== lastStage) { lastStage = h.stage; console.log("      engine stage:", h.stage || "ready"); } return h.ready; }, EXE ? 1200000 : 60000, 1000);
  check("engine up and Whisper model loaded", !!ready);
  const health = await api("/health");
  console.log("      hardware:", JSON.stringify(health.hardware));

  // ---------------------------------------------------------------- dictation into a focused field
  await app.evaluate(({ clipboard }) => clipboard.writeText("SENTINEL-CLIPBOARD"));
  // Windows only lets a process take the foreground right after input; a tap of Shift grants that (Alt would open the window's menu).
  let focused = false;
  for (let i = 0; i < 8 && !focused; i++) {
    uIOhook.keyTap(K.Shift); await sleep(80);
    focused = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle().includes("test field"));
      w.setAlwaysOnTop(true); w.show(); w.moveTop(); w.focus(); w.webContents.executeJavaScript("document.getElementById('t').focus()");
      return w.isFocused();
    });
    await sleep(300);
  }
  check("test field has keyboard focus", focused);
  const t0 = Date.now();
  uIOhook.keyToggle(K.Ctrl, "down"); await sleep(60); uIOhook.keyToggle(K.Space, "down");
  await sleep(3500);
  const overlay = app.windows().find((w) => w.url().includes("overlay.html"));
  if (overlay) await overlay.screenshot({ path: path.join(OUT, "overlay-listening.png"), omitBackground: true });
  await sleep(3500); // the fake microphone plays the 6 s utterance
  uIOhook.keyToggle(K.Space, "up"); const releasedAt = Date.now(); uIOhook.keyToggle(K.Ctrl, "up");
  const text = await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle().includes("test field")).webContents.executeJavaScript("document.getElementById('t').value")), 20000, 100);
  const latency = Date.now() - releasedAt;
  if (process.env.E2E_DEBUG) console.log("      field saw keys:", JSON.stringify(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle().includes("test field")).webContents.executeJavaScript("JSON.stringify({keys: keys, focus: document.hasFocus(), active: document.activeElement.id})"))));
  console.log(`      pasted: ${JSON.stringify(text)}   (${latency} ms after release)`);
  check("hold Ctrl+Space dictates into the focused app", !!text && /invoices/i.test(text));
  check("self-correction applied (Monday, not Friday)", !!text && /Monday/.test(text) && !/Friday/.test(text));
  check("filler removed", !!text && !/\bum\b/i.test(text));
  check("number kept", !!text && /25/.test(text));
  check("paste arrived within 3 s of release", latency < 3000, `${latency} ms`);
  await sleep(700);
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  check("clipboard restored after paste", clip === "SENTINEL-CLIPBOARD", JSON.stringify(clip));

  const entries = await until(async () => { const e = await api("/entries"); return e.length ? e : null; }, 5000);
  check("dictation saved to history", !!entries && entries[0].kind === "dictation" && /invoices/i.test(entries[0].raw));
  check("history keeps raw and cleaned separately", !!entries && entries[0].raw !== entries[0].cleaned);
  await page.waitForSelector(".row", { timeout: 8000 });
  await page.screenshot({ path: path.join(OUT, "after-dictation.png") });

  // silent / too short press stores nothing
  const before = (await api("/entries")).length;
  uIOhook.keyToggle(K.Ctrl, "down"); await sleep(40); uIOhook.keyToggle(K.Space, "down"); await sleep(120); uIOhook.keyToggle(K.Space, "up"); uIOhook.keyToggle(K.Ctrl, "up");
  await sleep(2500);
  check("a quick accidental tap stores nothing", (await api("/entries")).length === before);

  // ---------------------------------------------------------------- search + re-clean through the UI
  await page.fill("#q", "invoices"); await sleep(600);
  check("search finds it", (await page.locator(".row").count()) === 1);
  await page.click(".row"); await sleep(400);
  await page.selectOption("#aStyle", "bullets"); await sleep(900);
  check("re-clean as bullets from the detail panel", /^- /.test((await page.innerText("#dBody")).trim()));
  await page.screenshot({ path: path.join(OUT, "detail.png") });
  await page.fill("#q", ""); await sleep(400);

  // ---------------------------------------------------------------- note mode (microphone)
  await page.evaluate(() => window.echo.noteStart()).then((r) => check("note mode starts", r.ok, JSON.stringify(r)));
  await until(async () => ((await api("/notes/live")).transcript || "").length > 0, 25000, 500);
  const live = await api("/notes/live");
  check("live transcript fills while listening", live.active && live.seconds >= 4.5 && (live.transcript || "").length > 0, `${live.seconds?.toFixed?.(1)} s, ${JSON.stringify(live.transcript || "").slice(0, 60)}`);
  await page.screenshot({ path: path.join(OUT, "live-note.png") });
  await page.click("#liveFinish");
  const note = await until(async () => (await api("/entries?kind=note"))[0], 30000, 500);
  check("note finishes with a structured note", !!note && /^# /.test(note.cleaned) && /## Summary/.test(note.cleaned), note && note.title);
  check("note keeps the raw transcript", !!note && /invoices/i.test(note.raw));
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, "note.png") });

  // ---------------------------------------------------------------- note mode (computer audio loopback)
  await api("/settings", { method: "PUT", body: JSON.stringify({ note_sources: "system" }) });
  await page.evaluate(() => window.echo.settingsChanged());
  const ok = await page.evaluate(() => window.echo.noteStart());
  check("note mode can capture computer audio", ok.ok, JSON.stringify(ok));
  if (ok.ok) {
    // play the speech through the speakers so the loopback has something to hear
    try { execFileSync("powershell", ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${path.join(FIX, "short.wav")}').PlaySync()`], { timeout: 20000 }); } catch { /* ignore */ }
    await until(async () => ((await api("/notes/live")).transcript || "").length > 0, 15000, 500);
    const l2 = await api("/notes/live");
    console.log("      loopback transcript:", JSON.stringify(l2.transcript || "").slice(0, 100));
    check("computer audio was transcribed", /invoices|sam|monday/i.test(l2.transcript || ""));
    await page.evaluate(() => window.echo.noteCancel());
  }

  // ---------------------------------------------------------------- engine crash recovery
  await app.evaluate(() => { global.__echo.engine.proc.kill(); });
  const back = await until(async () => { const w = app.windows().find((x) => x.url().includes("127.0.0.1")); if (!w) return null; return (await w.locator(".row").count()) > 0 ? w : null; }, 40000, 500);
  check("engine restarts after a crash and the dashboard reconnects", !!back);

  await app.close();
  fs.rmSync(data, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  console.log("screenshots:", OUT);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
