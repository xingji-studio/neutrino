// The Web access switch: enabling it must move the running listener from
// loopback to every interface (0.0.0.0), exactly like --lan, without dropping
// the port or the browser that asked; disabling it must bring it back.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-web-lan-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.NEUTRINO_PLAN = "off";
const { loadConfig, saveConfig } = await import("../dist/config.js");
const { seedProPresets } = await import("./pro-presets.mjs");
// The Pro settings page reads presets from disk: write them for this run.
seedProPresets(["cheap", "medium", "best"]);
const { startWebServer, isWildcardHost, lanAddresses } = await import("../dist/web/server.js");

let server;
let cookie;

async function request(route, { body, method, anonymous = false } = {}) {
  const response = await fetch(server.url + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(!anonymous && cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: JSON.parse(text) };
}

/** Can a client open a TCP connection to this address? (loopback when off) */
function reachable(address, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The one LAN address worth probing, or null when this host has none. */
function probeAddress() {
  const address = lanAddresses()[0];
  return address ? { address } : null;
}

try {
  saveConfig({ unrelated: "keep" });
  server = await startWebServer({ port: 0 });
  assert.equal(server.host, "127.0.0.1", "a fresh console listens on loopback only");
  assert.equal(isWildcardHost(server.host), false);
  assert.equal(server.url, `http://127.0.0.1:${server.port}`);
  assert.deepEqual(server.urls, [`http://127.0.0.1:${server.port}/`]);
  const port = server.port;

  assert.equal((await request("/api/settings", { anonymous: true })).status, 401);
  const login = await request("/api/auth/login", { body: { password: "114514" } });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];

  const initial = await request("/api/settings");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.settings.web_lan, false, "the switch starts off");
  assert.equal(initial.data.settings.web_host, "127.0.0.1");
  assert.deepEqual(initial.data.settings.web_urls, [], "nothing is reachable from another device");

  // --- turn it on: same port, every interface, live cookie -----------------
  const enabled = await request("/api/settings", { body: { settings: { web_lan: true } } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.settings.web_lan, true);
  assert.equal(enabled.data.settings.web_host, "0.0.0.0");
  assert.equal(server.host, "0.0.0.0");
  assert.equal(server.port, port, "the port must not move; open links keep working");
  assert.equal(loadConfig().web_lan, true, "the choice is persisted for the next launch");
  assert.equal(loadConfig().unrelated, "keep", "unrelated settings are preserved");
  assert.ok(server.urls.some((url) => url.includes("127.0.0.1")), "loopback still works");
  const lan = probeAddress();
  if (lan) {
    assert.ok(enabled.data.settings.web_urls.length > 0, "the response lists an address to open elsewhere");
    assert.ok(await reachable(lan.address, port), `the listener answers on ${lan.address}`);
  }
  // The login cookie belongs to the process, not to one socket: the switch
  // must not sign the browser out.
  assert.equal((await request("/api/settings")).status, 200, "the session survives the switch");

  // Saving another setting must not move the listener or rewrite the switch.
  const unrelatedWhileLan = await request("/api/settings", { body: { settings: { sound_alerts: false } } });
  assert.equal(unrelatedWhileLan.status, 200);
  assert.equal(server.host, "0.0.0.0", "unrelated settings keep the current interface");
  assert.equal(loadConfig().web_lan, true);

  // --- turn it off again ---------------------------------------------------
  const disabled = await request("/api/settings", { body: { settings: { web_lan: false } } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.settings.web_lan, false);
  assert.equal(disabled.data.settings.web_host, "127.0.0.1");
  assert.equal(server.host, "127.0.0.1");
  assert.equal(loadConfig().web_lan, false);
  if (lan) assert.equal(await reachable(lan.address, port), false, "the LAN address is closed again");

  // Invalid values must never move the socket.
  assert.equal((await request("/api/settings", { body: { settings: { web_lan: "yes" } } })).status, 400);
  assert.equal(server.host, "127.0.0.1", "a rejected patch leaves the listener alone");
  // A patch that does not mention the switch leaves both the socket and the
  // saved preference untouched (the CLI may have chosen the interface).
  assert.equal((await request("/api/settings", { body: { settings: { sound_alerts: true } } })).status, 200);
  assert.equal(server.host, "127.0.0.1");
  assert.equal(loadConfig().web_lan, false);

  // --- the listener is process-wide, so /pro controls the same socket ------
  assert.equal((await request("/pro/api/settings", { body: { settings: { web_lan: true } } })).status, 200);
  assert.equal(server.host, "0.0.0.0", "a Pro settings save moves the shared listener");
  assert.equal((await request("/api/settings")).data.settings.web_lan, true, "both workspaces see the same switch");
  assert.equal((await request("/pro/api/settings", { body: { settings: { web_lan: false } } })).status, 200);
  assert.equal(server.host, "127.0.0.1");
  assert.equal((await request("/api/settings")).data.settings.web_lan, false);
  assert.equal(loadConfig().web_lan, false);

  // --- a saved preference behaves like --lan on the next start ------------
  saveConfig({ ...loadConfig(), web_lan: true });
  await server.close();
  server = await startWebServer({ port: 0 });
  assert.equal(server.host, "0.0.0.0", "a saved LAN preference starts on every interface");
  assert.ok(isWildcardHost(server.host));
  assert.equal(server.url, `http://127.0.0.1:${server.port}`);
  assert.ok(server.urls.some((url) => url.includes("127.0.0.1")));

  // An explicit interface from the command line still wins for that run.
  await server.close();
  server = await startWebServer({ port: 0, host: "127.0.0.1" });
  assert.equal(server.host, "127.0.0.1", "--host overrides the saved preference");
  const relogin = await request("/api/auth/login", { body: { password: "114514" } });
  assert.equal(relogin.status, 200);
  cookie = relogin.headers.get("set-cookie").split(";")[0];
  // Editing another setting must not pin the interface the flag chose.
  assert.equal((await request("/api/settings", { body: { settings: { sound_alerts: false } } })).status, 200);
  assert.equal(server.host, "127.0.0.1", "--host still decides after an unrelated save");
  assert.equal(loadConfig().web_lan, true, "the unrelated save leaves the saved preference alone");

  console.log("ok web LAN switch: immediate 0.0.0.0 binding, preserved port/login, shared workspace and --lan startup");
} finally {
  if (server) await server.close();
  fs.rmSync(testHome, { recursive: true, force: true });
}
