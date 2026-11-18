// Update path, end to end, without touching GitHub: the packaged app (older version) is pointed at a local
// "release" folder holding a newer build's installer and latest.yml. It must find it, download it, verify it,
// and show "Update ready". It does not run the installer.
// Usage: node tests/update-e2e.js <packaged EchoFlow.exe> <folder with latest.yml + installer>
const { _electron: electron } = require("playwright");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const [exe, feedDir] = process.argv.slice(2);
if (!exe || !feedDir) { console.error("usage: node tests/update-e2e.js <exe> <feedDir>"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
async function until(fn, ms, step = 500) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > end) return null; await sleep(step); } }

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(feedDir, decodeURIComponent(req.url.split("?")[0]));
    if (!file.startsWith(path.resolve(feedDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
    const size = fs.statSync(file).size, range = req.headers.range;
    if (range) {
      const [a, b] = range.replace("bytes=", "").split("-"); const start = +a, end = b ? +b : size - 1;
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else { res.writeHead(200, { "content-length": size, "accept-ranges": "bytes" }); fs.createReadStream(file).pipe(res); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const data = fs.mkdtempSync(path.join(os.tmpdir(), "echoflow-upd-"));
  const env = { ...process.env, ECHOFLOW_DATA_DIR: data, ECHOFLOW_TEST: "1", ECHOFLOW_UPDATE_URL: `http://127.0.0.1:${port}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: exe, args: [], env });
  const page = await until(() => app.windows().find((w) => w.url().includes("127.0.0.1:") && !w.url().includes(`:${port}`)), 30000);
  check("packaged app opens", !!page);
  await page.setViewportSize({ width: 1320, height: 840 });

  const first = await page.evaluate(() => window.echo.update.get());
  check("updater is active in the packaged app", first.enabled === true, `running ${first.current}`);
  await page.evaluate(() => window.echo.update.check());
  const state = await until(async () => { const s = await page.evaluate(() => window.echo.update.get()); return ["ready", "error", "current"].includes(s.status) ? s : null; }, 180000);
  console.log("      update state:", JSON.stringify(state));
  check("newer version found, downloaded and verified", !!state && state.status === "ready" && state.version !== state.current, state && `${state.current} -> ${state.version}`);

  await page.waitForSelector("#updateBanner:not([hidden])", { timeout: 8000 }).catch(() => {});
  check("sidebar shows 'Update ready'", await page.locator("#updateBanner").isVisible());
  await page.screenshot({ path: path.join(os.tmpdir(), "echoflow-update-banner.png") });
  await page.click('.nav[data-view="settings"]'); await sleep(600);
  check("Settings shows the Updates section", (await page.locator("text=Update automatically").count()) > 0);
  await app.close(); server.close(); fs.rmSync(data, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
