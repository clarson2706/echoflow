// Launches the app against a data dir and saves screenshots: node scripts/shot.js DATA_DIR OUT_DIR
const { _electron: electron } = require("playwright");
const cleanEnv = (extra) => { const e = { ...process.env, ...extra }; delete e.ELECTRON_RUN_AS_NODE; return e; };
const path = require("path");
(async () => {
  const [data, out] = [process.argv[2], process.argv[3]];
  const app = await electron.launch({ args: ["."], cwd: path.join(__dirname, ".."), env: cleanEnv({ ECHOFLOW_DATA_DIR: data, ECHOFLOW_TEST: "1", ECHOFLOW_DEBUG: "1" }) });
  let page;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => w.url().includes("127.0.0.1")); if (!page) await new Promise((r) => setTimeout(r, 500)); }
  if (!page) throw new Error("dashboard window never appeared");
  await page.setViewportSize({ width: 1320, height: 840 });
  await page.waitForSelector(".row", { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, "history.png") });
  await page.click(".row >> nth=0"); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "detail.png") });
  await page.click('.nav[data-view="notes"]'); await page.waitForTimeout(400);
  await page.click(".row >> nth=0"); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "note.png") });
  await page.click('.nav[data-view="dictionary"]'); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, "dictionary.png") });
  await page.click('.nav[data-view="settings"]'); await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, "settings.png") });
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
