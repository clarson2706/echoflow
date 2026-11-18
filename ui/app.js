"use strict";
// EchoFlow dashboard. Talks to the local engine with a per-launch token; inside the desktop shell
// window.echo (preload) adds recording controls.

const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get("token");
  try { if (fromUrl) sessionStorage.setItem("echo-token", fromUrl); return fromUrl || sessionStorage.getItem("echo-token") || ""; }
  catch { return fromUrl || ""; }
})();

const $ = (s, r = document) => r.querySelector(s);
const STYLES = { clean: "Clean", bullets: "Bullets", todo: "To-do", email: "Email", message: "Message" };
const TEMPLATES = { meeting: "Meeting", lecture: "Lecture", memo: "Brain-dump", journal: "Journal" };

const S = { update: null, view: "history", entries: [], sel: null, kind: "", app: "", q: "", settings: null, health: null, dict: null, apps: [], showRaw: false, editing: false };

async function api(path, opts = {}) {
  const r = await fetch("/api" + path, { ...opts, headers: { "x-echo-token": TOKEN, ...(opts.body ? { "content-type": "application/json" } : {}), ...opts.headers } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
const put = (p, b, m = "PUT") => api(p, { method: m, body: JSON.stringify(b) });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast glass"; t.textContent = msg; t.setAttribute("role", "status");
  document.body.append(t); setTimeout(() => t.remove(), 2600);
}

// ---------------------------------------------------------------- formatting
function md(src) {
  const lines = String(src || "").split("\n"); let out = "", list = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
  const close = () => { if (list) { out += "</ul>"; list = false; } };
  for (const l of lines) {
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) { close(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = l.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i))) { if (!list) { out += "<ul>"; list = true; } out += `<li class="task">${inline(m[2])}</li>`; }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (!list) { out += "<ul>"; list = true; } out += `<li>${inline(m[1])}</li>`; }
    else if (l.trim()) { close(); out += `<p>${inline(l)}</p>`; }
    else close();
  }
  close(); return out;
}
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dayLabel(t) {
  const d = new Date(t * 1000), n = new Date(), days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (days === 0) return "Today"; if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
function preview(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => l.startsWith("- "))) return lines.map((l) => l.replace(/^-\s*(\[ \]\s*)?/, "")).join("  ·  ");
  return lines.join(" ");
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const humanKey = (k) => k.replace(/Control/g, "Ctrl").replace(/\+/g, " + ");

// ---------------------------------------------------------------- data
async function loadEntries() {
  const p = new URLSearchParams({ q: S.q, kind: S.view === "notes" ? "note" : S.kind, app_name: S.app });
  S.entries = await api("/entries?" + p);
  const all = await api("/entries?limit=1000");
  $("#cHistory").textContent = all.length || ""; $("#cNotes").textContent = all.filter((e) => e.kind === "note").length || "";
  S.apps = await api("/apps");
}
async function refresh() { if (["history", "notes"].includes(S.view)) { await loadEntries(); render(); } }

// ---------------------------------------------------------------- rendering
function renderStatus() {
  const h = S.health, el = $("#status");
  if (!h) { el.innerHTML = `<b><span class="dot bad"></span>Engine offline</b>`; return; }
  const hw = h.hardware || {};
  const STAGES = { "gpu-libs": "Setting up GPU support", "model-download": "Downloading speech model", loading: "Loading model" };
  const state = h.error ? ["bad", "Model error"] : h.ready ? ["ok", "Ready"] : ["busy", STAGES[h.stage] || "Loading model"];
  const key = S.settings ? humanKey(S.settings.hotkey) : "Ctrl + Space";
  el.innerHTML = `<b><span class="dot ${state[0]}"></span>${state[1]}</b>
    <span>${esc(hw.gpu || "CPU")} &middot; ${esc(hw.model || "")}</span>
    <span>Hold <span class="kbd">${esc(key)}</span> to speak</span>`;
}

function render() {
  document.querySelectorAll(".nav").forEach((b) => b.dataset.view === S.view ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  $("#title").textContent = { history: "History", notes: "Notes", dictionary: "Dictionary", settings: "Settings" }[S.view];
  $("#searchBox").hidden = !["history", "notes"].includes(S.view);
  const list = ["history", "notes"].includes(S.view);
  $("#app").classList.toggle("with-detail", list && !!S.sel);
  $("#detail").hidden = !(list && S.sel);
  ({ history: renderList, notes: renderList, dictionary: renderDictionary, settings: renderSettings })[S.view]();
  if (list && S.sel) renderDetail();
  renderStatus();
}

function renderList() {
  const v = $("#view"), key = S.settings ? humanKey(S.settings.hotkey) : "Ctrl + Space";
  let html = "";
  if (S.view === "history") {
    html += `<div class="filters">${[["", "All"], ["dictation", "Dictations"], ["note", "Notes"]].map(([k, n]) => `<button class="chip" data-kind="${k}" aria-pressed="${S.kind === k}">${n}</button>`).join("")}
      ${S.apps.length ? `<select id="appFilter" aria-label="Filter by app"><option value="">Any app</option>${S.apps.map((a) => `<option ${a === S.app ? "selected" : ""}>${esc(a)}</option>`).join("")}</select>` : ""}</div>`;
  }
  if (!S.entries.length) {
    const searching = S.q || S.kind || S.app;
    html += `<div class="empty"><h2>${searching ? "Nothing matches." : S.view === "notes" ? "No notes yet." : "Quiet so far."}</h2>
      <p>${searching ? "Try a different word, or clear the filters." : S.view === "notes" ? "Choose Start note, then talk through a meeting or lecture. You will get a finished note when you stop." : `Hold <span class="kbd">${esc(key)}</span> in any app and speak. What you say, cleaned up, appears here.`}</p></div>`;
    v.innerHTML = html; bindList(); return;
  }
  let last = "";
  for (const e of S.entries) {
    const d = dayLabel(e.created_at);
    if (d !== last) { html += `<div class="day">${esc(d)}</div>`; last = d; }
    const isNote = e.kind === "note";
    const flag = e.flags === "fallback" ? `<span class="badge">Basic cleanup</span>` : e.flags === "fact-check" ? `<span class="badge">Fact check</span>` : e.flags === "recovered" ? `<span class="badge">Recovered</span>` : "";
    html += `<button class="row" data-id="${e.id}" aria-selected="${S.sel === e.id}">
      <span class="time">${clock(e.created_at)}</span>
      <span class="meta"><b>${esc(isNote ? "Note" : e.app || "Unknown app")}</b><span>${esc(isNote ? mmss(e.duration) : STYLES[e.style] || e.style)}</span></span>
      <span class="text ${isNote ? "title" : ""}">${esc(isNote ? e.title : preview(e.cleaned))}${flag}</span></button>`;
  }
  v.innerHTML = html; bindList();
}
function bindList() {
  document.querySelectorAll(".chip").forEach((c) => c.onclick = () => { S.kind = c.dataset.kind; refresh(); });
  const af = $("#appFilter"); if (af) af.onchange = () => { S.app = af.value; refresh(); };
  document.querySelectorAll(".row").forEach((r) => r.onclick = () => { S.sel = +r.dataset.id; S.showRaw = false; S.editing = false; render(); });
}

function renderDetail() {
  const e = S.entries.find((x) => x.id === S.sel) || S.cur;
  const el = $("#detail");
  if (!e) { S.sel = null; render(); return; }
  S.cur = e;
  const isNote = e.kind === "note";
  const kinds = isNote ? TEMPLATES : STYLES;
  el.innerHTML = `<header><h2>${esc(isNote ? e.title : e.app || "Dictation")}</h2><button class="close" aria-label="Close" id="dClose">&times;</button></header>
    <div class="meta-line"><span>${new Date(e.created_at * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
      <span>${isNote ? mmss(e.duration) : esc(STYLES[e.style] || e.style)}</span><span>${e.provider === "rules" ? "Local cleanup" : esc(e.provider)}</span></div>
    <div class="body">
      ${isNote ? `<div class="md" id="dBody">${md(e.cleaned)}</div>` : `<div class="plain" id="dBody" ${S.editing ? 'contenteditable="true"' : ""}>${esc(e.cleaned)}</div>`}
      <button class="raw-toggle" id="dRawBtn">${S.showRaw ? "Hide" : "Show"} original transcript</button>
      ${S.showRaw ? `<div class="raw">${esc(e.raw)}</div>` : ""}
    </div>
    <div class="actions">
      <button class="btn small" id="aCopy">Copy</button>
      ${isNote ? "" : `<button class="btn small" id="aEdit">${S.editing ? "Save" : "Edit"}</button>`}
      <select class="field-input" id="aStyle" style="height:32px;min-width:0" aria-label="Re-clean as"><option value="">${isNote ? "Rewrite as" : "Re-clean as"}</option>${Object.entries(kinds).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select>
      <button class="btn small" id="aExport">Export</button>
      <button class="btn small danger" id="aDelete">Delete</button></div>`;
  $("#dClose").onclick = () => { S.sel = null; render(); };
  $("#dRawBtn").onclick = () => { S.showRaw = !S.showRaw; renderDetail(); };
  $("#aCopy").onclick = async () => { try { await navigator.clipboard.writeText(e.cleaned); toast("Copied"); } catch { toast("Could not copy"); } };
  const ed = $("#aEdit");
  if (ed) ed.onclick = async () => {
    if (S.editing) { const text = $("#dBody").innerText.replace(/\n$/, ""); await put(`/entries/${e.id}`, { cleaned: text }, "PATCH"); S.editing = false; await refresh(); toast("Saved"); }
    else { S.editing = true; renderDetail(); $("#dBody").focus(); }
  };
  $("#aStyle").onchange = async (ev) => { if (!ev.target.value) return; ev.target.disabled = true; try { await put(`/entries/${e.id}/reclean`, { style: ev.target.value }, "POST"); await refresh(); toast("Updated"); } catch { toast("Could not re-clean"); } };
  $("#aExport").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([e.cleaned], { type: "text/markdown" })); a.download = `echoflow-${e.id}.md`; a.click(); };
  $("#aDelete").onclick = async () => { if (!confirm("Delete this entry? This cannot be undone.")) return; await api(`/entries/${e.id}`, { method: "DELETE" }); S.sel = null; await refresh(); };
}

// ---------------------------------------------------------------- dictionary
async function renderDictionary() {
  S.dict = await api("/dictionary");
  const d = S.dict, v = $("#view");
  v.innerHTML = `<div class="section"><h3>Names and terms</h3><p>Words EchoFlow should always spell your way, such as people, products and jargon. They also help the speech model hear them.</p>
      <div class="pair"><input type="text" id="termIn" placeholder="Add a name or term" aria-label="New term"><button class="btn small primary" id="termAdd">Add</button></div>
      <div class="term-list">${d.terms.map((t) => `<span class="term">${esc(t)}<button data-term="${esc(t)}" aria-label="Remove ${esc(t)}">&times;</button></span>`).join("") || `<span style="color:var(--faint)">None yet.</span>`}</div></div>
    <div class="section"><h3>Replacements</h3><p>When you say one thing and want another written, such as a spoken shorthand.</p>
      <div class="pair"><input type="text" id="repSrc" placeholder="When I say" aria-label="When I say"><input type="text" id="repDst" placeholder="Write" aria-label="Write"><button class="btn small primary" id="repAdd">Add</button></div>
      <div class="panel" ${Object.keys(d.replacements).length ? "" : "hidden"}>${Object.entries(d.replacements).map(([a, b]) => `<div class="rep"><span>${esc(a)}</span><span class="arrow">&rarr;</span><span>${esc(b)}</span><button data-src="${esc(a)}" aria-label="Remove">Remove</button></div>`).join("")}</div></div>`;
  const addTerm = async () => { const t = $("#termIn").value.trim(); if (t) { await put("/dictionary", { term: t }, "POST"); renderDictionary(); } };
  $("#termAdd").onclick = addTerm; $("#termIn").onkeydown = (e) => e.key === "Enter" && addTerm();
  $("#repAdd").onclick = async () => { const a = $("#repSrc").value.trim(), b = $("#repDst").value.trim(); if (a && b) { await put("/dictionary", { src: a, dst: b }, "POST"); renderDictionary(); } };
  v.querySelectorAll("[data-term]").forEach((b) => b.onclick = async () => { await api("/dictionary?term=" + encodeURIComponent(b.dataset.term), { method: "DELETE" }); renderDictionary(); });
  v.querySelectorAll("[data-src]").forEach((b) => b.onclick = async () => { await api("/dictionary?src=" + encodeURIComponent(b.dataset.src), { method: "DELETE" }); renderDictionary(); });
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const s = S.settings, h = S.health || {}, hw = h.hardware || {}, v = $("#view");
  if (!s) { v.innerHTML = ""; return; }
  const sel = (id, opts, cur) => `<select class="field-input" id="${id}">${Object.entries(opts).map(([k, n]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${n}</option>`).join("")}</select>`;
  const sw = (id, on) => `<input type="checkbox" class="switch" id="${id}" role="switch" ${on ? "checked" : ""}>`;
  v.innerHTML = `
  <div class="section"><h3>Dictation</h3><p>Hold the key, speak, let go. The cleaned text lands in whichever app you are using.</p><div class="panel">
    <div class="field"><label for="hotkey">Hold to talk</label><small>Click, then press the keys you want. Ctrl + Space by default.</small><input type="text" id="hotkey" readonly value="${esc(humanKey(s.hotkey))}"></div>
    <div class="field"><label for="toggle_mode">Tap to start, tap to stop</label><small>For hands-free use instead of holding the key.</small>${sw("toggle_mode", s.toggle_mode)}</div>
    <div class="field"><label for="style">Writing style</label><small>Auto picks a style from the app you are in, such as Email for Gmail.</small>${sel("style", { auto: "Auto", ...STYLES }, s.style)}</div></div></div>
  <div class="section"><h3>Cleanup</h3><p>Basic cleanup runs on your computer. A model gives better rewording; it only sees the words you spoke, never audio or window titles.</p><div class="panel">
    <div class="field"><label for="provider">Cleanup model</label><small>Basic is free and offline.</small>${sel("provider", { rules: "Basic (offline)", gemini: "Google Gemini", openai: "OpenAI compatible" }, s.provider)}</div>
    <div class="field" data-for="gemini"><label for="gemini_key">Gemini API key</label><small>Stored encrypted for your Windows account, not in the history database.</small><input type="password" id="gemini_key" placeholder="${s.gemini_key ? "Saved" : "Paste key"}" autocomplete="off"></div>
    <div class="field" data-for="gemini"><label for="gemini_model">Gemini model</label><span></span><input type="text" id="gemini_model" value="${esc(s.gemini_model)}"></div>
    <div class="field" data-for="openai"><label for="openai_base_url">Endpoint</label><small>OpenAI, OpenRouter, or a local server such as Ollama (http://localhost:11434/v1).</small><input type="text" id="openai_base_url" value="${esc(s.openai_base_url)}"></div>
    <div class="field" data-for="openai"><label for="openai_key">API key</label><span></span><input type="password" id="openai_key" placeholder="${s.openai_key ? "Saved" : "Optional for local"}" autocomplete="off"></div>
    <div class="field" data-for="openai"><label for="openai_model">Model</label><span></span><input type="text" id="openai_model" value="${esc(s.openai_model)}"></div></div></div>
  <div class="section"><h3>Notes</h3><p>Note mode listens for as long as you like and ends with a structured note.</p><div class="panel">
    <div class="field"><label for="note_template">Default template</label><span></span>${sel("note_template", TEMPLATES, s.note_template)}</div>
    <div class="field"><label for="note_sources">Listen to</label><small>Computer audio captures calls and recorded lectures.</small>${sel("note_sources", { mic: "Microphone", system: "Computer audio", both: "Both" }, s.note_sources)}</div>
    <div class="field"><label for="note_hotkey">Start or stop a note</label><small>Click, then press the keys.</small><input type="text" id="note_hotkey" readonly value="${esc(humanKey(s.note_hotkey))}"></div></div></div>
  <div class="section"><h3>Privacy</h3><p>Speech is transcribed on this computer. Nothing is uploaded unless you add a cleanup model above.</p><div class="panel">
    <div class="field"><label for="keep_text">Keep history</label><small>Off means dictations are pasted but never saved.</small>${sw("keep_text", s.keep_text)}</div>
    <div class="field"><label>Clear history</label><small>Removes every dictation and note.</small><button class="btn small danger" id="clearAll">Clear all</button></div></div></div>
  ${S.update && S.update.enabled ? `<div class="section"><h3>Updates</h3><p>EchoFlow ${esc(S.update.current)}. ${esc(updateLine(S.update))}</p><div class="panel">
    <div class="field"><label for="auto_update">Update automatically</label><small>Checks for a new version every few hours and installs it when you restart.</small>${sw("auto_update", s.auto_update !== false)}</div>
    <div class="field"><label>Version</label><small>${esc(updateLine(S.update))}</small><button class="btn small" id="updBtn">${S.update.status === "ready" ? "Restart to update" : S.update.status === "available" ? "Download " + esc(S.update.version) : "Check for updates"}</button></div></div></div>` : ""}
  <div class="section"><h3>This computer</h3><div class="panel"><div class="hw"><span><b>${esc(hw.gpu || "No NVIDIA GPU")}</b> ${hw.vram_gb ? `(${hw.vram_gb} GB)` : ""}</span><span>Speech model: <b>${esc(hw.model || "")}</b> on ${esc(hw.device || "")}</span><span>${esc(hw.reason || "")}</span><span>EchoFlow ${esc(h.version || "")}</span></div></div></div>`;

  const showFor = () => v.querySelectorAll("[data-for]").forEach((f) => f.hidden = f.dataset.for !== $("#provider").value);
  showFor();
  const save = async (patch) => { S.settings = await put("/settings", patch); window.echo?.settingsChanged?.(); renderStatus(); };
  ["style", "provider", "note_template", "note_sources"].forEach((id) => $("#" + id).onchange = (e) => { save({ [id]: e.target.value }); if (id === "provider") showFor(); });
  const ub = $("#updBtn"); if (ub) ub.onclick = () => updateAction();
  ["toggle_mode", "keep_text", "auto_update"].forEach((id) => $("#" + id).onchange = (e) => save({ [id]: e.target.checked }));
  ["gemini_model", "openai_base_url", "openai_model"].forEach((id) => $("#" + id).onchange = (e) => save({ [id]: e.target.value.trim() }));
  ["gemini_key", "openai_key"].forEach((id) => $("#" + id).onchange = async (e) => { await save({ [id]: e.target.value.trim() }); e.target.value = ""; e.target.placeholder = S.settings[id] ? "Saved" : "Paste key"; toast(e.target.placeholder === "Saved" ? "Key saved" : "Key removed"); });
  for (const id of ["hotkey", "note_hotkey"]) {
    const inp = $("#" + id);
    inp.onkeydown = (ev) => {
      ev.preventDefault();
      if (["Control", "Shift", "Alt", "Meta"].includes(ev.key)) return;
      const parts = [ev.ctrlKey && "Control", ev.altKey && "Alt", ev.shiftKey && "Shift"].filter(Boolean);
      if (!parts.length) { toast("Include Ctrl, Alt or Shift"); return; }
      const key = ev.code === "Space" ? "Space" : ev.key.length === 1 ? ev.key.toUpperCase() : ev.key;
      const combo = [...parts, key].join("+");
      inp.value = humanKey(combo); save({ [id]: combo }); inp.blur(); toast("Shortcut saved");
    };
  }
  $("#clearAll").onclick = async () => { if (confirm("Delete every dictation and note?")) { await api("/entries", { method: "DELETE" }); S.sel = null; await loadEntries(); toast("History cleared"); } };
}

// ---------------------------------------------------------------- updates
function updateLine(u) {
  return ({ idle: "Not checked yet.", checking: "Checking for updates.", current: "You are up to date.", available: `Version ${u.version} is available.`,
    downloading: `Downloading ${u.version || "the update"}${u.progress ? " (" + u.progress + "%)" : ""}.`, ready: `Version ${u.version} is ready. Restart to install.`,
    error: "Could not check: " + (u.error || "no connection") + ".", unsupported: "Updates are only available in the installed app." })[u.status] || "";
}
async function updateAction() {
  const u = S.update; if (!u || !window.echo?.update) return;
  if (u.status === "ready") return window.echo.update.install();
  if (u.status === "available") return window.echo.update.download();
  S.update = await window.echo.update.check(); renderUpdate();
}
function renderUpdate() {
  const b = $("#updateBanner"), u = S.update;
  const show = u && ["ready", "downloading", "available"].includes(u.status);
  b.hidden = !show;
  if (show) { b.innerHTML = u.status === "ready" ? `Update ready<small>Restart to install ${esc(u.version)}</small>` : u.status === "available" ? `Update available<small>Download ${esc(u.version)}</small>` : `Downloading update<small>${u.progress || 0}%</small>`; b.onclick = updateAction; }
  if (S.view === "settings" && document.activeElement?.tagName !== "INPUT") renderSettings();
}

// ---------------------------------------------------------------- note mode
let liveTimer = null, noteActive = false;
async function pollLive() {
  try {
    const l = await api("/notes/live");
    noteActive = l.active; $("#live").hidden = !l.active;
    if (l.active) { $("#liveTime").textContent = mmss(l.seconds); const tx = $("#liveTx"); if (tx.textContent !== l.transcript) { tx.textContent = l.transcript; tx.scrollTop = tx.scrollHeight; } }
    $("#noteBtn").innerHTML = l.active ? `<span class="rec"></span>Finish note` : `<span class="rec"></span>Start note`;
  } catch { /* engine restarting */ }
}
async function startNote() {
  if (!window.echo) { try { await put("/notes/start", {}, "POST"); } catch { toast("Engine not ready yet"); } }
  else { const r = await window.echo.noteStart(); if (!r?.ok) { toast(r?.error || "Could not start"); return; } }
  pollLive();
}
async function finishNote() {
  $("#liveFinish").disabled = true; $("#noteBtn").disabled = true;
  try {
    const r = window.echo ? await window.echo.noteFinish() : await put("/notes/finish", {}, "POST");
    if (r.empty) toast("Nothing was said"); else { S.view = "notes"; S.sel = r.id; S.q = ""; S.kind = ""; await loadEntries(); render(); toast("Note saved"); }
  } catch { toast("Could not finish the note"); }
  $("#liveFinish").disabled = false; $("#noteBtn").disabled = false; pollLive();
}
$("#noteBtn").onclick = () => (noteActive ? finishNote() : startNote());
$("#liveFinish").onclick = finishNote;
$("#liveCancel").onclick = async () => { if (window.echo) await window.echo.noteCancel(); else await put("/notes/cancel", {}, "POST"); pollLive(); };

// ---------------------------------------------------------------- boot
document.querySelectorAll(".nav").forEach((b) => b.onclick = async () => { S.view = b.dataset.view; S.sel = null; S.q = ""; $("#q").value = ""; await refresh(); render(); });
let qt; $("#q").oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value; refresh(); }, 160); };
document.addEventListener("keydown", (e) => { if (e.key === "/" && document.activeElement.tagName !== "INPUT" && !$("#searchBox").hidden) { e.preventDefault(); $("#q").focus(); } if (e.key === "Escape" && S.sel) { S.sel = null; render(); } });

async function boot() {
  try { S.settings = await api("/settings"); S.health = await api("/health"); } catch { S.health = null; }
  await loadEntries().catch(() => {}); render(); pollLive();
  let known = S.entries[0]?.id;
  setInterval(async () => {
    try {
      S.health = await api("/health"); renderStatus(); pollLive();
      if (["history", "notes"].includes(S.view) && !S.editing && document.activeElement.id !== "q") {
        const latest = (await api("/entries?limit=1"))[0]?.id;
        if (latest !== known) { known = latest; await loadEntries(); render(); }
      }
    } catch { S.health = null; renderStatus(); }
  }, 1500);
}
boot();
if (window.echo?.update) { window.echo.update.get().then((u) => { S.update = u; renderUpdate(); }); window.echo.update.onState((u) => { S.update = u; renderUpdate(); }); }
if (window.echo?.onNavigate) window.echo.onNavigate((v) => { S.view = v; S.sel = null; refresh().then(render); });
