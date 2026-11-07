// Opt-in live smoke test; excluded from npm test to avoid external availability dependencies.
// NEUTRINO_SEARCH_ENGINES can force a provider, or pass --fail-primary to verify real failover.
import assert from "node:assert/strict";
import { executeTool } from "../dist/llm/tools.js";

const originalFetch = globalThis.fetch;
const originalOrder = process.env.NEUTRINO_SEARCH_ENGINES;
let blocked = 0;
try {
  if (process.argv.includes("--fail-primary")) {
    process.env.NEUTRINO_SEARCH_ENGINES = "bing-cn,360";
    globalThis.fetch = (url, init) => {
      if (new URL(url).hostname === "cn.bing.com") {
        blocked++;
        return Promise.reject(new TypeError("fetch failed", {
          cause: Object.assign(new Error("Simulated primary DNS failure"), { code: "EAI_AGAIN" }),
        }));
      }
      return originalFetch(url, init);
    };
  }
  const start = Date.now();
  const raw = await executeTool("web_search", {
    query: "site:typescriptlang.org TypeScript documentation",
    max_results: 3,
    reason: "Verify live public search results and automatic provider failover.",
  });
  assert.ok(!raw.startsWith("[Error:"), raw);
  const result = JSON.parse(raw);
  assert.ok(result.results.length > 0, "live search must return results");
  for (const item of result.results) {
    assert.ok(item.title);
    assert.match(item.url, /^https?:\/\//);
    assert.equal(typeof item.snippet, "string");
  }
  if (process.argv.includes("--fail-primary")) {
    assert.ok(blocked > 0, "the primary source was attempted and failed");
    assert.equal(result.provider, "360 Search");
  }
  console.log(JSON.stringify({ elapsedMs: Date.now() - start, simulatedPrimaryFailures: blocked, ...result }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (originalOrder === undefined) delete process.env.NEUTRINO_SEARCH_ENGINES;
  else process.env.NEUTRINO_SEARCH_ENGINES = originalOrder;
}
