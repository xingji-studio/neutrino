// Tests for reaching the web UI from another device: which addresses the server
// advertises, and the access token that guards them.
//
// The token is not decoration. `/api/live/:key/message` drives an agent with
// shell access and `/api/overview` lists every conversation on disk, so a
// server another machine can reach must refuse callers that were not handed the
// secret. The policy is tested without binding a socket (`describeWebAccess`)
// and then enforced against a real server on loopback.
import {
  describeWebAccess,
  isLoopbackHost,
  lanAddresses,
  resolveWebToken,
  startWebServer,
  webUrls,
} from "../dist/web/server.js";

let failures = 0;
function fail(message) {
  failures += 1;
  console.log("FAIL " + message);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${message}: expected ${b}, got ${a}`);
}

// ---------------------------------------------------------------- host policy

equal(
  ["127.0.0.1", "localhost", "127.5.5.5", "::1", "[::1]"].map(isLoopbackHost),
  [true, true, true, true, true],
  "loopback hosts are recognised",
);
equal(
  ["0.0.0.0", "::", "192.168.1.5", "10.8.0.2", "100.64.0.7", ""].map(isLoopbackHost),
  [false, false, false, false, false, false],
  "wildcard and LAN hosts are not loopback",
);

const lan = lanAddresses();
assert(Array.isArray(lan), "lanAddresses returns an array");
for (const address of lan) {
  assert(/^\d{1,3}(\.\d{1,3}){3}$/.test(address), `LAN address is IPv4: ${address}`);
  assert(address !== "127.0.0.1", "loopback is never advertised as a LAN address");
}

// ------------------------------------------------------------------- defaults

const loopbackDefault = describeWebAccess({ port: 8765 });
equal(loopbackDefault.token, null, "loopback bind needs no token");
equal(loopbackDefault.url, "http://127.0.0.1:8765", "loopback url");
equal(loopbackDefault.urls, ["http://127.0.0.1:8765/"], "loopback advertises only itself");

const exposed = describeWebAccess({ port: 8765, host: "0.0.0.0" });
assert(typeof exposed.token === "string" && exposed.token.length >= 24, "exposing generates a long token");
assert(/^[A-Za-z0-9_-]+$/.test(exposed.token), "generated token is URL-safe and header-safe");
assert(
  exposed.urls.every((url) => url.includes(`/?t=${exposed.token}`)),
  "advertised URLs carry the token so a phone can just open one",
);
assert(exposed.urls.includes("http://127.0.0.1:8765/?t=" + exposed.token), "loopback stays usable");
for (const address of lan) {
  assert(
    exposed.urls.includes(`http://${address}:8765/?t=${exposed.token}`),
    `LAN address is advertised: ${address}`,
  );
}
equal(exposed.url, "http://127.0.0.1:8765", "wildcard binds still yield a usable loopback url");

const regenerated = describeWebAccess({ port: 8765, host: "0.0.0.0" });
assert(regenerated.token !== exposed.token, "each exposure gets its own token");

equal(
  resolveWebToken("127.0.0.1", "keepme"),
  "keepme",
  "an explicit token is honoured even on loopback",
);
equal(resolveWebToken("0.0.0.0", null), null, "null disables authentication explicitly");
assert(resolveWebToken("0.0.0.0", "  ") !== null, "blank token still protects an exposed bind");

const pinned = describeWebAccess({ port: 9000, host: "192.168.1.5", token: "s3cret" });
equal(pinned.url, "http://192.168.1.5:9000", "bound host is the primary url");
equal(pinned.urls, ["http://192.168.1.5:9000/?t=s3cret"], "pinned token is advertised");

const open = describeWebAccess({ port: 8765, host: "0.0.0.0", token: null });
assert(open.token === null, "--no-auth really disables the token");
assert(
  open.urls.every((url) => !url.includes("t=")),
  "no dead ?t= parameter is advertised when auth is off",
);

equal(
  webUrls("127.0.0.1", 80, "a b&c"),
  { url: "http://127.0.0.1:80", urls: ["http://127.0.0.1:80/?t=a%20b%26c"] },
  "token is URL-encoded",
);

// -------------------------------------------------------------- real server

const TOKEN = "test-token-abcdefghijklmnop";
const server = await startWebServer({ port: 0, host: "127.0.0.1", token: TOKEN });
const base = server.url;

async function status(pathOrUrl, init) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : base + pathOrUrl;
  const response = await fetch(url, init);
  // Drain so the socket can be reused and the process can exit.
  await response.text().catch(() => "");
  return response;
}

try {
  equal(server.token, TOKEN, "handle reports the enforced token");

  const anonymous = await status("/api/overview", { cache: "no-store" });
  equal(anonymous.status, 401, "no token is rejected");
  assert(
    (anonymous.headers.get("www-authenticate") ?? "").startsWith("Bearer"),
    "401 advertises the scheme",
  );

  equal(
    (await status("/api/overview", { headers: { "X-Neutrino-Token": "nope" } })).status,
    401,
    "wrong header token is rejected",
  );
  equal(
    (await status("/api/overview?t=nope")).status,
    401,
    "wrong query token is rejected",
  );
  equal(
    (await status("/api/overview", { headers: { Authorization: "Bearer nope" } })).status,
    401,
    "wrong bearer token is rejected",
  );

  equal(
    (await status("/api/overview", { headers: { "X-Neutrino-Token": TOKEN } })).status,
    200,
    "X-Neutrino-Token is accepted",
  );
  equal(
    (await status("/api/overview", { headers: { Authorization: `Bearer ${TOKEN}` } })).status,
    200,
    "Authorization: Bearer is accepted",
  );
  equal(
    (await status(`/api/overview?t=${TOKEN}`)).status,
    200,
    "query token is accepted (SSE needs this)",
  );

  // The page itself must load without a token: that is how the unlock prompt
  // gets on screen in the first place. Static files are not secret.
  const page = await status("/");
  equal(page.status, 200, "index.html is served without a token");
  const script = await status("/app.js");
  equal(script.status, 200, "app.js is served without a token");

  // The exact URL printed by the terminal must work end to end.
  const advertised = server.urls[0];
  const opened = await status(advertised);
  equal(opened.status, 200, `advertised URL opens the UI: ${advertised}`);

  equal(
    (await status("/api/overview", { method: "OPTIONS" })).status,
    204,
    "preflight needs no token and reveals nothing",
  );

  equal(
    (await status("/api/live/missing/stream")).status,
    401,
    "the SSE stream is guarded",
  );
  const stream = await status(`/api/live/missing/stream?t=${TOKEN}`);
  assert(stream.status !== 401, "the SSE stream accepts the query token");
  equal(stream.status, 404, "authenticated SSE for an unknown session is 404");

  equal(
    (await status(`/api/session/whatever/continue`, { method: "POST" })).status,
    401,
    "driving the agent requires the token",
  );
  equal(
    (await status(`/api/live/missing/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    })).status,
    401,
    "sending a message requires the token",
  );

  // Guards must not have opened a hole in static serving.
  equal((await status("/../package.json")).status, 404, "path traversal still blocked");
} finally {
  await server.close();
}

// Loopback without an explicit token stays open, so `neutrino web` on the same
// machine does not need a secret.
const localOnly = await startWebServer({ port: 0 });
try {
  equal(localOnly.token, null, "loopback server has no token");
  equal(
    (await fetch(localOnly.url + "/api/overview")).status,
    200,
    "existing local usage keeps working unauthenticated",
  );
} finally {
  await localOnly.close();
}

if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("web access policy ok");
