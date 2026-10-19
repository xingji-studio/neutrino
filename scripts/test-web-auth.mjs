// Password authentication is exercised over real HTTP with an isolated config.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-web-password-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const { startWebServer, webUrls, isLoopbackHost, lanAddresses } = await import("../dist/web/server.js");
const { loadConfig, saveConfig, CONFIG_FILE } = await import("../dist/config.js");
const { SettingsScreen } = await import("../dist/screens/settings.js");
const { Buffer: ScreenBuffer } = await import("../dist/terminal/buffer.js");
const { defaultState } = await import("../dist/state.js");
assert.ok(CONFIG_FILE.startsWith(testHome + path.sep));

assert.ok(isLoopbackHost("127.0.0.1"));
assert.ok(!isLoopbackHost("0.0.0.0"));
for (const address of lanAddresses()) assert.match(address, /^\d+(\.\d+){3}$/);
assert.deepEqual(webUrls("127.0.0.1", 8765).urls, ["http://127.0.0.1:8765/"]);
assert.ok(webUrls("0.0.0.0", 8765).urls.every(url => !url.includes("?")));

let server;
async function request(route, { cookie, body, method, headers = {} } = {}) {
  const response = await fetch(server.url + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: text.startsWith("{") ? JSON.parse(text) : null };
}
const cookieFrom = response => response.headers.get("set-cookie")?.split(";")[0];
const login = password => request("/api/auth/login", { body: { password } });

try {
  server = await startWebServer({ port: 0 });
  assert.equal(server.authRequired, true, "loopback requires password too");
  const initialHash = loadConfig().web_password_hash;
  assert.match(initialHash, /^scrypt:/);
  assert.ok(!fs.readFileSync(CONFIG_FILE, "utf8").includes("114514"));
  for (const route of ["/", "/app.js", "/settings.js", "/style.css"]) {
    assert.equal((await request(route)).status, 200, "static login assets are public");
  }
  for (const route of ["/api/health", "/api/overview", "/api/settings", "/api/live/missing/stream"]) {
    assert.equal((await request(route)).status, 401, `anonymous API denied: ${route}`);
  }
  assert.equal((await request("/api/settings", { body: { settings: { web_password: "intruder" } } })).status, 401);
  assert.equal((await request("/api/overview", { method: "OPTIONS" })).status, 204);
  assert.equal((await request("/api/auth/login")).status, 405);
  assert.equal((await login("wrong")).status, 401);
  assert.equal((await login(114514)).status, 401);
  assert.equal((await login(" ")).status, 401);
  assert.equal((await login("a".repeat(257))).status, 401);
  assert.equal((await request("/api/auth/login", { body: null })).status, 401);
  assert.equal((await request("/api/auth/login", { body: { password: "114514" }, headers: { Origin: "http://evil.example" } })).status, 403);
  const signedIn = await login("114514");
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=31536000/);
  let cookie = cookieFrom(signedIn);
  assert.ok(cookie && !cookie.includes("114514"));
  assert.equal((await request("/api/overview", { cookie })).status, 200);
  assert.equal((await request("/api/live/missing/stream", { cookie })).status, 404, "SSE uses cookie authentication");
  assert.equal((await request("/api/overview", { cookie: cookie + "tampered" })).status, 401);
  assert.equal((await request("/api/overview?t=114514", { headers: { "X-Neutrino-Token": "114514", Authorization: "Bearer 114514" } })).status, 401, "legacy credentials do not bypass login");
  const settings = await request("/api/settings", { cookie });
  assert.equal(settings.status, 200);
  assert.ok(!settings.text.includes(initialHash));
  assert.ok(!settings.text.includes("114514"));
  assert.ok(!settings.text.includes("web_password"));
  assert.equal((await request("/api/settings", { cookie, body: { settings: { web_password: "new", invalid: true } } })).status, 400);
  assert.equal(loadConfig().web_password_hash, initialHash, "invalid patch never changes password");
  assert.equal((await request("/api/settings", { cookie, body: { settings: { web_password: "" } } })).status, 400);
  assert.equal((await request("/api/settings", { cookie, body: { settings: { web_password: "no" } }, headers: { Origin: "http://evil.example" } })).status, 403);

  const config = loadConfig();
  config.test_preserved = "keep me";
  saveConfig(config);
  const changed = await request("/api/settings", { cookie, body: { settings: { web_password: " permanent password 密码 " } } });
  assert.equal(changed.status, 200);
  assert.equal(loadConfig().test_preserved, "keep me");
  assert.equal((await request("/api/overview", { cookie })).status, 401, "old browsers are signed out");
  cookie = cookieFrom(changed);
  assert.equal((await request("/api/overview", { cookie })).status, 200, "settings browser stays signed in");
  assert.equal((await login("114514")).status, 401, "default password stops working after change");
  assert.equal((await login("permanent password 密码")).status, 401, "password whitespace is significant");
  assert.equal((await login(" permanent password 密码 ")).status, 200);
  await server.close();
  server = await startWebServer({ port: 0 });
  assert.equal((await login(" permanent password 密码 ")).status, 200, "password survives restart");
  assert.equal((await request("/api/overview", { cookie })).status, 200, "remembered login survives restart");
  assert.equal((await login("114514")).status, 401);

  // Change the same persistent password through the real terminal Settings UI.
  const screen = new SettingsScreen();
  screen.app = { state: defaultState(), width: 80, height: 24, render() {}, popScreen() {} };
  screen.onActivate();
  const key = name => screen.onKey({ name, char: "", ctrl: false, meta: false, shift: false, sequence: "" });
  // web_password is the last row; the list wraps, so walk it exactly.
  for (let i = 0; i < 5; i++) key("down");
  key("enter");
  screen.onPaste("terminal-password");
  const buf = new ScreenBuffer(80, 24);
  screen.render(buf);
  assert.ok(!buf.cells.flat().map(cell => cell.ch).join("").includes("terminal-password"), "password input is masked");
  key("escape");
  assert.equal((await login("terminal-password")).status, 401, "cancel does not save");
  key("enter");
  screen.onPaste("terminal-password");
  key("enter");
  assert.equal((await request("/api/overview", { cookie })).status, 401, "terminal password change invalidates old browser cookies immediately");
  assert.equal((await login(" permanent password 密码 ")).status, 401);
  const terminalLogin = await login("terminal-password");
  assert.equal(terminalLogin.status, 200);
  const loggedOut = await request("/api/auth/logout", { method: "POST", cookie: cookieFrom(terminalLogin) });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get("set-cookie"), /Max-Age=0/);
  await server.close();
  server = await startWebServer({ port: 0, auth: false });
  assert.equal(server.authRequired, false);
  assert.equal((await request("/api/overview")).status, 200, "--no-auth remains an explicit opt-out");
  console.log("WEB PASSWORD AUTH TESTS PASSED");
} finally {
  if (server) await server.close();
  fs.rmSync(testHome, { recursive: true, force: true });
}
