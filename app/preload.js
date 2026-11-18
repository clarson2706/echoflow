// Bridge for the dashboard page (which is served by the local engine).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("echo", {
  shell: true,
  noteStart: () => ipcRenderer.invoke("note:start"),
  noteFinish: () => ipcRenderer.invoke("note:finish"),
  noteCancel: () => ipcRenderer.invoke("note:cancel"),
  settingsChanged: () => ipcRenderer.invoke("settings:changed"),
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    onState: (cb) => ipcRenderer.on("update:state", (_e, s) => cb(s)),
  },
  onNavigate: (cb) => ipcRenderer.on("navigate", (_e, view) => cb(view)),
});
window.addEventListener("DOMContentLoaded", () => document.body.classList.add("shell"));
