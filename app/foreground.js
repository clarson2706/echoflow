// Which app has focus, via Win32. The label is used locally to pick a writing style; only the label
// (never the window title) is sent to the engine.
let fns = null;
try {
  if (process.platform === "win32") {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll"), kernel32 = koffi.load("kernel32.dll");
    fns = {
      fg: user32.func("void* __stdcall GetForegroundWindow()"),
      pid: user32.func("uint32_t __stdcall GetWindowThreadProcessId(void* hwnd, _Out_ uint32_t* pid)"),
      title: user32.func("int __stdcall GetWindowTextW(void* hwnd, _Out_ uint16_t* buf, int max)"),
      open: kernel32.func("void* __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
      image: kernel32.func("int __stdcall QueryFullProcessImageNameW(void* h, uint32_t flags, _Out_ uint16_t* buf, _Inout_ uint32_t* size)"),
      close: kernel32.func("int __stdcall CloseHandle(void* h)"),
    };
  }
} catch { fns = null; }

const FRIENDLY = { chrome: "Chrome", msedge: "Edge", firefox: "Firefox", brave: "Brave", code: "VS Code", winword: "Word",
  outlook: "Outlook", notepad: "Notepad", slack: "Slack", discord: "Discord", teams: "Teams", ms_teams: "Teams",
  whatsapp: "WhatsApp", notion: "Notion", obsidian: "Obsidian", cursor: "Cursor", windowsterminal: "Terminal",
  electron: "EchoFlow", echoflow: "EchoFlow", claude: "Claude" };
const str = (u16) => { let s = ""; for (const c of u16) { if (!c) break; s += String.fromCharCode(c); } return s; };

/** @param knownApps keywords (e.g. "gmail", "slack") that may appear in a browser tab title. */
function foreground(knownApps = []) {
  if (!fns) return { label: "", exe: "" };
  try {
    const hwnd = fns.fg();
    if (!hwnd) return { label: "", exe: "" };
    const t = new Uint16Array(256); fns.title(hwnd, t, 256);
    const pid = [0]; fns.pid(hwnd, pid);
    const h = fns.open(0x1000, 0, pid[0]);
    let exe = "";
    if (h) { const b = new Uint16Array(520), size = [520]; if (fns.image(h, 0, b, size)) exe = str(b).split("\\").pop().replace(/\.exe$/i, ""); fns.close(h); }
    const title = str(t).toLowerCase();
    const hit = knownApps.find((k) => title.includes(k));
    const label = hit ? hit[0].toUpperCase() + hit.slice(1) : FRIENDLY[exe.toLowerCase()] || exe;
    return { label, exe };
  } catch { return { label: "", exe: "" }; }
}

module.exports = { foreground };
