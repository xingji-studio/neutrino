// Exercise real local sockets: proxy use, remote DNS, NO_PROXY and stale-proxy recovery.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createSearchTransport, bypassSearchProxy } from "../dist/llm/searchNetwork.js";

const names = ["NEUTRINO_SEARCH_PROXY", "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"];
const original = new Map(names.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const sockets = new Set();
const requests = [];
let directCalls = 0;
const proxy = http.createServer((request, response) => {
  requests.push({ url: request.url, auth: request.headers["proxy-authorization"] });
  response.end("through proxy");
});
proxy.on("connect", (request, socket) => {
  requests.push({ url: request.url, auth: request.headers["proxy-authorization"] });
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nthrough proxy"));
});
const target = http.createServer((_request, response) => { directCalls++; response.end("direct"); });
for (const server of [proxy, target]) server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

async function request(url) {
  const transport = await createSearchTransport();
  try { return await (await transport.fetch(new URL(url), { signal: AbortSignal.timeout(2000) })).text(); }
  finally { await transport.close(); }
}

try {
  for (const name of names) delete process.env[name];
  proxy.listen(0, "127.0.0.1");
  target.listen(0, "127.0.0.1");
  await Promise.all([once(proxy, "listening"), once(target, "listening")]);
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const targetUrl = `http://127.0.0.1:${target.address().port}/search?q=public`;

  process.env.NEUTRINO_SEARCH_PROXY = proxyUrl;
  assert.equal(await request("http://does-not-exist.invalid/search?q=public"), "through proxy");
  assert.ok(requests[0].url.includes("does-not-exist.invalid"), "the proxy receives the hostname without local DNS resolution");
  console.log("ok   explicit proxy and remote DNS work through real sockets");

  process.env.NEUTRINO_SEARCH_PROXY = proxyUrl.replace("http://", "http://search-user:search-password@");
  assert.equal(await request("http://does-not-exist.invalid/"), "through proxy");
  assert.equal(requests.at(-1).auth, `Basic ${Buffer.from("search-user:search-password").toString("base64")}`);
  console.log("ok   proxy authentication uses the proxy header");

  delete process.env.NEUTRINO_SEARCH_PROXY;
  process.env.http_proxy = proxyUrl;
  process.env.HTTP_PROXY = "http://127.0.0.1:1";
  assert.equal(await request("http://does-not-exist.invalid/"), "through proxy", "lowercase takes precedence");
  process.env.no_proxy = "127.0.0.1";
  const beforeBypass = requests.length;
  assert.equal(await request(targetUrl), "direct");
  assert.equal(requests.length, beforeBypass);
  console.log("ok   environment precedence and NO_PROXY bypass work through real sockets");

  process.env.no_proxy = "";
  for (const code of ["EAI_AGAIN", "ECONNRESET"]) {
    const transport = await createSearchTransport();
    try {
      globalThis.fetch = async () => { throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("the search provider failed"), { code, hostname: "does-not-exist.invalid" }),
      }); };
      await assert.rejects(transport.fetch(new URL("http://does-not-exist.invalid/"), {}), /fetch failed/);
      globalThis.fetch = originalFetch;
      const response = await transport.fetch(new URL("http://does-not-exist.invalid/"), { signal: AbortSignal.timeout(2000) });
      assert.equal(await response.text(), "through proxy", "a provider failure must not disable the working proxy");
    } finally { globalThis.fetch = originalFetch; await transport.close(); }
  }
  console.log("ok   provider DNS/reset failures never disable a healthy proxy");

  process.env.no_proxy = "";
  process.env.http_proxy = "http://127.0.0.1:1";
  assert.equal(await request(targetUrl), "direct", "a stale optional proxy falls back to a reachable direct source");
  const beforeRequired = directCalls;
  process.env.NEUTRINO_SEARCH_PROXY = "http://127.0.0.1:1";
  await assert.rejects(request(targetUrl), /fetch failed/);
  assert.equal(directCalls, beforeRequired, "a required proxy is never silently bypassed");
  process.env.NEUTRINO_SEARCH_PROXY = "direct";
  assert.equal(await request(targetUrl), "direct");
  console.log("ok   stale optional proxy recovery and explicit routing controls work");

  for (const [url, rules, expected] of [
    ["https://cn.bing.com/", "*", true],
    ["https://cn.bing.com/", ".bing.com", true],
    ["https://bing.com/", ".bing.com", true],
    ["https://cn.bing.com/", "*.bing.com:443", true],
    ["https://cn.bing.com/", "*.bing.com:80", false],
    ["https://cn.bing.com/", "bing.com", false],
    ["https://evilbing.com/", ".bing.com", false],
    ["https://localhost/", "<local>", true],
    ["https://cn.bing.com/", "<local>", false],
    ["http://127.0.0.1/", "127.*", true],
    ["http://[::1]:8080/", "[::1]:8080", true],
  ]) assert.equal(bypassSearchProxy(new URL(url), rules), expected, `${url} with ${rules}`);
  console.log("ok   proxy exclusions support ports, IPv6, subdomains and Windows wildcards");
  console.log("Search network tests passed: 6 checks");
} finally {
  globalThis.fetch = originalFetch;
  for (const socket of sockets) socket.destroy();
  await Promise.all([proxy, target].filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
