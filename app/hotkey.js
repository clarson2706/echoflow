// Global hold-to-talk. Electron's globalShortcut swallows the key press and fires on key down;
// uiohook watches for the key up, which globalShortcut cannot see.
const { globalShortcut } = require("electron");
const { uIOhook, UiohookKey: K } = require("uiohook-napi");

const MODS = { control: [K.Ctrl, K.CtrlRight], ctrl: [K.Ctrl, K.CtrlRight], alt: [K.Alt, K.AltRight],
  shift: [K.Shift, K.ShiftRight], meta: [K.Meta, K.MetaRight], super: [K.Meta, K.MetaRight] };

function keycodesFor(accel) {
  const parts = accel.split("+").map((p) => p.trim());
  const main = parts.pop();
  const mods = parts.flatMap((p) => MODS[p.toLowerCase()] || []);
  const name = main.length === 1 ? main.toUpperCase() : main[0].toUpperCase() + main.slice(1);
  const code = K[name] ?? K[main];
  return { mods, main: code === undefined ? [] : [code] };
}

class Hotkeys {
  constructor() {
    this.bindings = new Map(); // name -> {accel, mode, keys, held, armed, onDown, onUp, timer}
    this.started = false;
    this.enabled = true;
  }

  start() {
    if (this.started) return;
    this.started = true;
    uIOhook.on("keyup", (e) => {
      for (const b of this.bindings.values()) {
        const hit = b.keys.mods.includes(e.keycode) || b.keys.main.includes(e.keycode);
        if (!hit) continue;
        if (b.mode === "hold" && b.held) { b.held = false; clearTimeout(b.timer); b.onUp(); }
        if (b.mode === "toggle" && b.keys.main.includes(e.keycode)) b.armed = true;
      }
    });
    uIOhook.start();
  }

  /** mode "hold": onDown on press, onUp on release. mode "toggle": onDown on every press. */
  bind(name, accel, { mode, onDown, onUp, maxHoldMs = 120000 }) {
    this.unbind(name);
    const b = { accel, mode, onDown, onUp, keys: keycodesFor(accel), held: false, armed: true, timer: null };
    const ok = globalShortcut.register(accel, () => {
      if (!this.enabled) return;
      if (mode === "hold") {
        if (b.held) return; // key auto-repeat
        b.held = true;
        b.timer = setTimeout(() => { if (b.held) { b.held = false; onUp(); } }, maxHoldMs); // never stick on
        onDown();
      } else if (b.armed) { b.armed = false; onDown(); }
    });
    if (ok) this.bindings.set(name, b);
    return ok;
  }

  unbind(name) {
    const b = this.bindings.get(name);
    if (b) { globalShortcut.unregister(b.accel); clearTimeout(b.timer); this.bindings.delete(name); }
  }

  stop() {
    globalShortcut.unregisterAll();
    if (this.started) { try { uIOhook.stop(); } catch { /* already stopped */ } }
  }
}

module.exports = { Hotkeys, keycodesFor };
