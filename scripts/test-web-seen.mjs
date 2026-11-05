// The blue dot in the sidebar is the console's own memory of which finished
// conversations the reader has already opened. It must outlive a reload *and* a
// restart of the browser process, and it is not a conversation setting, so the
// server keeps it in its own file (~/.neutrino/web.json) rather than in
// config.json or a transcript. Everything here runs against a temporary home
// directory, over real HTTP.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-seen-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.NEUTRINO_PLAN = "off";
const { loadConfig, saveConfig, CONFIG_FILE } = await import("../dist/config.js");
const { WEB_STATE_FILE, SEEN_LIMIT, isSeenIdentity, loadSeen, updateSeen } = await import("../dist/web/clientState.js");
const { startWebServer } = await import("../dist/web/server.js");

let server;
async function start() {
  const handle = await startWebServer({ port: 0, auth: false });
  return handle;
}

async function request(route, { body, method, headers = {} } = {}) {
  const response = await fetch(server.url + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

function readStateFile() {
  return JSON.parse(fs.readFileSync(WEB_STATE_FILE, "utf-8"));
}

try {
  saveConfig({ approval_mode: "request", plan_first: false });

  // --- where the record lives ----------------------------------------------
  assert.equal(WEB_STATE_FILE, path.join(testHome, ".neutrino", "web.json"),
    "the console keeps its own file next to the CLI config");
  assert.deepEqual(loadSeen(), [], "a fresh install has nothing recorded");

  server = await start();

  // --- the endpoint --------------------------------------------------------
  {
    const empty = await request("/api/seen");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, { seen: [] }, "nothing is recorded yet");

    const added = await request("/api/seen", { body: { identities: ["id:2025-01-02T03-04-05-678Z"], seen: true } });
    assert.equal(added.status, 200);
    assert.deepEqual(added.data.seen, ["id:2025-01-02T03-04-05-678Z"], "the opened conversation is recorded");

    assert.deepEqual((await request("/api/seen")).data.seen, ["id:2025-01-02T03-04-05-678Z"],
      "a later read sees the record");
    assert.deepEqual(readStateFile(), { seen: { standard: ["id:2025-01-02T03-04-05-678Z"] } },
      "the file holds the record under the workspace name");

    // The browser also records a conversation that has no history yet.
    await request("/api/seen", { body: { identities: ["live:L7"], seen: true } });
    assert.deepEqual((await request("/api/seen")).data.seen, ["id:2025-01-02T03-04-05-678Z", "live:L7"],
      "newest last, so trimming keeps the most recent");

    const forgotten = await request("/api/seen", { body: { identities: ["live:L7"], seen: false } });
    assert.deepEqual(forgotten.data.seen, ["id:2025-01-02T03-04-05-678Z"], "new activity forgets the record");
  }

  // --- the terminal UI never sees this data --------------------------------
  {
    assert.equal(loadConfig().seen, undefined, "the CLI config does not grow a web-only key");
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    assert.equal(config.seen, undefined, "the config file on disk holds no seen record");
  }

  // --- a restart keeps the record ------------------------------------------
  // This is the report that started this file: the dot came back after the
  // console was restarted, because the record only lived in the page.
  {
    await server.close();
    server = await start();
    assert.deepEqual((await request("/api/seen")).data.seen, ["id:2025-01-02T03-04-05-678Z"],
      "restarting the console does not bring the dot back");
  }

  // --- rejected bodies -----------------------------------------------------
  {
    const cases = [
      [{ identities: [], seen: true }, "an empty list changes nothing"],
      [{ identities: "id:s1", seen: true }, "identities must be a list"],
      [{ identities: ["s1"], seen: true }, "an identity needs its kind prefix"],
      [{ identities: ["../etc/passwd"], seen: true }, "a path is not an identity"],
      [{ identities: ["id:s1"], seen: "yes" }, "seen must be a boolean"],
      [{ identities: ["id:s1"], seen: true, extra: 1 }, "unknown fields are refused"],
      [{ identities: [`id:${"x".repeat(500)}`], seen: true }, "an identity has a bounded length"],
    ];
    for (const [body, label] of cases) {
      assert.equal((await request("/api/seen", { body })).status, 400, label);
    }
    assert.equal((await request("/api/seen", { method: "DELETE" })).status, 405, "only GET and POST are served");
    assert.deepEqual((await request("/api/seen")).data.seen, ["id:2025-01-02T03-04-05-678Z"],
      "a refused body leaves the record alone");

    // The route is a mutation: another site must not be able to drive it.
    const crossOrigin = await request("/api/seen", {
      body: { identities: ["id:s2"], seen: true },
      headers: { Origin: "http://example.invalid" },
    });
    assert.equal(crossOrigin.status, 403, "a cross-origin write is refused");
    assert.deepEqual((await request("/api/seen")).data.seen, ["id:2025-01-02T03-04-05-678Z"],
      "the refused write changed nothing");
  }

  // --- the record stays bounded -------------------------------------------
  {
    const batch = (from, count) => Array.from({ length: count }, (_, index) => `id:s${from + index}`);
    assert.equal((await request("/api/seen", { body: { identities: batch(0, SEEN_LIMIT), seen: true } })).status, 200);
    await request("/api/seen", { body: { identities: batch(SEEN_LIMIT, 50), seen: true } });
    const stored = (await request("/api/seen")).data.seen;
    assert.equal(stored.length, SEEN_LIMIT, "only recent conversations are remembered");
    assert.equal(stored.at(-1), `id:s${SEEN_LIMIT + 49}`, "the newest conversation is kept");
    assert.equal(stored.includes("id:s0"), false, "the oldest entries fall out first");
  }

  // --- both workspaces keep their own record -------------------------------
  {
    const standard = loadSeen("standard");
    assert.deepEqual(updateSeen("pro", ["id:pro-1"], true), ["id:pro-1"], "Pro records its own sidebar");
    assert.deepEqual(loadSeen("pro"), ["id:pro-1"]);
    assert.deepEqual(loadSeen("standard"), standard, "the regular console is untouched");
    assert.deepEqual(readStateFile().seen.pro, ["id:pro-1"], "both records share the file");
    assert.deepEqual(loadSeen("standard").length, SEEN_LIMIT, "the standard record survived the Pro write");
  }

  // --- a damaged file is not fatal ----------------------------------------
  {
    fs.writeFileSync(WEB_STATE_FILE, "{ this is not json", "utf-8");
    assert.deepEqual((await request("/api/seen")).data.seen, [], "a broken file reads as an empty record");
    const written = await request("/api/seen", { body: { identities: ["id:after-damage"], seen: true } });
    assert.equal(written.status, 200, "the record can still be written");
    assert.deepEqual(written.data.seen, ["id:after-damage"]);
    assert.deepEqual(readStateFile(), { seen: { standard: ["id:after-damage"] } },
      "the damaged file is replaced by a valid one");
  }

  // --- identity validation is shared with the route ------------------------
  {
    assert.equal(isSeenIdentity("id:2025-01-02T03-04-05-678Z"), true);
    assert.equal(isSeenIdentity("live:L12"), true);
    assert.equal(isSeenIdentity("id:"), false);
    assert.equal(isSeenIdentity("2025-01-02"), false);
    assert.equal(isSeenIdentity(7), false);
  }

  console.log("web seen record: ok");
} finally {
  await server?.close();
}
