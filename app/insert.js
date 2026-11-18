// Puts text into whatever app has focus: clipboard paste, then restore what was on the clipboard.
const { clipboard } = require("electron");
const { uIOhook, UiohookKey: K } = require("uiohook-napi");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Newer Electron versions return promises from some clipboard calls; await works for both.
async function snapshot() {
  const snap = {};
  try {
    snap.text = await clipboard.readText();
    snap.html = await clipboard.readHTML();
    snap.rtf = await clipboard.readRTF();
    const img = await clipboard.readImage();
    if (img && !img.isEmpty()) snap.image = img;
  } catch { /* clipboard unavailable */ }
  return snap;
}

async function restore(snap) {
  try {
    const keep = Object.fromEntries(Object.entries(snap).filter(([, v]) => v && (typeof v !== "string" || v.length)));
    const keys = Object.keys(keep);
    if (!keys.length) await clipboard.clear();
    else if (keys.length === 1 && keep.text) await clipboard.writeText(keep.text);
    else await clipboard.write(keep);
  } catch (e) { if (process.env.ECHOFLOW_DEBUG) console.log("[shell] clipboard restore failed", e.message); }
}

/** Returns {ok, error?}. On failure the text is left on the clipboard so the user can paste it. */
async function insertText(text) {
  const before = await snapshot();
  try {
    await clipboard.writeText(text);
    await sleep(40);
    uIOhook.keyTap(K.V, [K.Ctrl]);
    await sleep(350); // let the target app read the clipboard before we put things back
    await restore(before);
    return { ok: true };
  } catch (e) {
    await clipboard.writeText(text);
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { insertText };
