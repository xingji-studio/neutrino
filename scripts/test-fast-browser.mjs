// Optional real-browser check. Set NEUTRINO_PLAYWRIGHT_MODULE to an installed playwright module.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fastDataOutput } from "./fast-data-paths.mjs";
import os from "node:os";
import path from "node:path";
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-browser-fixture-"));
const priorEnvironment = { NEUTRINO_HOME: process.env.NEUTRINO_HOME, NEUTRINO_PLUGIN_HOME: process.env.NEUTRINO_PLUGIN_HOME };
process.env.NEUTRINO_HOME = path.join(fixture, ".neutrino"); process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
const originalHomedir = os.homedir; os.homedir = () => fixture;
const { chromium } = await import(process.env.NEUTRINO_PLAYWRIGHT_MODULE || "playwright");
const config = await import("../dist/config.js");
const { WebSession } = await import("../dist/web/session.js");
const { startWebServer } = await import("../dist/web/server.js");
const model = { name: "Browser fixture", url: "https://fixture.invalid", api_key: "fixture", intensity: ["High"] };
config.saveModels({ providers: [{ name: "Fixture", models: [model] }] });
config.saveConfig({ ...config.DEFAULT_CONFIG, selected_provider: "Fixture", selected_model: model.name, language: "zh" });
const session = new WebSession({ id: "fast-browser-fixture", cwd: fixture, model: model.name, provider: "Fixture", intensity: "High",
  agent_mode: "standard", messages: [{ role: "user", content: "极速模式交互验证" }] }, model);
const key = session.start();
let server, browser;
try {
  server = await startWebServer({ port: 0, auth: false });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${server.url}/?live=${encodeURIComponent(key)}`);
  const picker = page.locator("#agent-mode-picker");
  await picker.locator("summary").waitFor({ state: "visible" });
  await picker.locator("summary").click();
  assert.equal(await picker.locator("[data-agent-mode]").count(), 5);
  const fast = picker.locator('[data-agent-mode="fast_dag"]');
  await fast.click();
  await page.waitForFunction(() => document.querySelector('[data-agent-mode="fast_dag"]').getAttribute("aria-checked") === "true");
  assert.equal(session.liveMeta().agentMode, "fast_dag");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#agent-mode-label").textContent === "极速模式");
  await picker.locator("summary").click();
  await fast.focus();
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.agentMode), "standard");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.agentMode), "ptc");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.agentMode), "pro");
  await page.keyboard.press("Escape");
  assert.equal(await picker.evaluate(node => node.open), false);
  await picker.locator("summary").click();
  // Linux test runners may not ship CJK fonts. Reuse the host's existing font for reviewable screenshots.
  const cjk = "/mnt/c/Windows/Fonts/msyh.ttc";
  if (fs.existsSync(cjk)) {
    await page.route("**/fixture-cjk-font", route => route.fulfill({ contentType: "font/collection", body: fs.readFileSync(cjk) }));
    await page.addStyleTag({ content: `@font-face { font-family: "FastTestCJK"; src: url("${server.url}/fixture-cjk-font"); } body, button, textarea, select { font-family: "FastTestCJK", sans-serif !important; }` });
    await page.evaluate(() => document.fonts.ready);
  }
  const desktopBox = await fast.boundingBox();
  assert.ok(desktopBox.x >= 0 && desktopBox.x + desktopBox.width <= 1360);
  await page.screenshot({ path: fastDataOutput("screenshots/fast-mode-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBox = await fast.boundingBox();
  assert.ok(mobileBox && mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 390 && mobileBox.y >= 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile has no horizontal overflow");
  await page.screenshot({ path: fastDataOutput("screenshots/fast-mode-mobile.png") });
  assert.deepEqual(errors, []);
  console.log("PASS Chromium desktop/mobile: five modes, actual selection request, selected style, refresh persistence, Home/End/arrows/Escape, responsive bounds, no console errors");
} finally {
  await browser?.close(); session.dispose(); await server?.close(); os.homedir = originalHomedir;
  fs.rmSync(fixture, { recursive: true, force: true });
  for (const [key, value] of Object.entries(priorEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
