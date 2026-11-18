// Auto-update from GitHub Releases (electron-updater). Quiet by default: checks on launch and every
// 6 hours, downloads in the background, and offers a restart. Updates can be switched off in Settings.
const { app, Notification } = require("electron");
const { EventEmitter } = require("events");

class Updater extends EventEmitter {
  constructor() {
    super();
    this.state = { status: "idle", current: app.getVersion(), version: null, progress: 0, error: "", enabled: false, auto: true, lastChecked: 0 };
    this.au = null;
    this.timer = null;
  }

  get supported() { return app.isPackaged || !!process.env.ECHOFLOW_UPDATE_URL; }

  init(auto = true) {
    this.state.auto = auto;
    if (!this.supported) return;
    const { autoUpdater } = require("electron-updater");
    this.au = autoUpdater;
    this.state.enabled = true;
    autoUpdater.autoDownload = auto;
    autoUpdater.autoInstallOnAppQuit = true;      // a pending update installs when the app next quits
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    if (process.env.ECHOFLOW_UPDATE_URL) {        // used by tests: a local folder served over http
      autoUpdater.setFeedURL({ provider: "generic", url: process.env.ECHOFLOW_UPDATE_URL });
      autoUpdater.forceDevUpdateConfig = true;
    }
    autoUpdater.on("checking-for-update", () => this.set({ status: "checking", error: "" }));
    autoUpdater.on("update-available", (i) => this.set({ status: this.state.auto ? "downloading" : "available", version: i.version, progress: 0 }));
    autoUpdater.on("update-not-available", () => this.set({ status: "current", lastChecked: Date.now() }));
    autoUpdater.on("download-progress", (p) => this.set({ status: "downloading", progress: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (i) => {
      this.set({ status: "ready", version: i.version, progress: 100 });
      try { new Notification({ title: "EchoFlow update ready", body: `Version ${i.version} will install when you restart.` }).show(); } catch { /* no notifications */ }
    });
    autoUpdater.on("error", (e) => this.set({ status: "error", error: String((e && e.message) || e).split("\n")[0].slice(0, 160) }));
    setTimeout(() => this.state.auto && this.check(), 15000);
    this.timer = setInterval(() => this.state.auto && this.check(), 6 * 3600 * 1000);
  }

  set(patch) { Object.assign(this.state, patch); this.emit("state", this.state); }
  setAuto(auto) { this.state.auto = auto; if (this.au) this.au.autoDownload = auto; this.emit("state", this.state); }

  async check() {
    if (!this.au) { this.set({ status: "unsupported" }); return this.state; }
    if (["downloading", "ready", "checking"].includes(this.state.status)) return this.state;
    try { await this.au.checkForUpdates(); } catch (e) { this.set({ status: "error", error: String(e.message || e).split("\n")[0].slice(0, 160) }); }
    return this.state;
  }

  async download() { if (this.au && this.state.status === "available") { this.set({ status: "downloading" }); await this.au.downloadUpdate().catch(() => {}); } return this.state; }
  install() { if (this.au && this.state.status === "ready") { this.au.quitAndInstall(true, true); return true; } return false; }
}

module.exports = { Updater };
