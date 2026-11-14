// A common billing boundary for Chat Completions and DeepSeek Messages agents.
// Credentials and prompts are never written to the usage ledger.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { ProxyAgent, fetch as upstreamFetch } from "undici";

const integer = value => Number.isSafeInteger(value) && value >= 0;
export async function createTokenGateway(options) {
  const { upstream, apiKey, clientKey, model = "deepseek-flash", tokenCap, ledgerFile,
    maxOutputTokens = 16384, requestCap = 500, fetchImpl = upstreamFetch, proxy } = options;
  if (!Number.isSafeInteger(tokenCap) || tokenCap < 1 || !apiKey || !clientKey) throw new Error("Invalid gateway credentials/limits");
  const initial = { schema: 1, cap: tokenCap, output_ceiling: maxOutputTokens, request_cap: requestCap,
    model, effort: "max", spent_protected: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
    held_tokens: 0, unknown_requests: 0, rejected_before_dispatch: 0, stopped: false, attempts: [] };
  const state = ledgerFile && fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")) : initial;
  if (state.cap !== tokenCap || state.model !== model) throw new Error("Refusing a different campaign's ledger");
  for (const attempt of state.attempts) if (attempt.protected_tokens === null) {
    attempt.protected_tokens = attempt.reserved; attempt.usage_complete = false; attempt.error = "gateway_restart";
    state.spent_protected += attempt.reserved; state.held_tokens -= attempt.reserved; state.unknown_requests++;
  }
  const persist = () => {
    if (!ledgerFile) return;
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile + ".tmp", JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(ledgerFile + ".tmp", ledgerFile);
  };
  persist();
  let closing = false;
  const active = new Set();
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const reject = (response, code, message) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "invalid_request_error", code, message } }));
  };
  const server = http.createServer(async (request, response) => {
    response.on("error", () => {});
    try {
      const key = request.headers.authorization?.replace(/^Bearer /i, "") || request.headers["x-api-key"];
      if (key !== clientKey) return reject(response, "benchmark_auth", "Invalid local trial credential");
      if (request.method === "GET" && request.url === "/__usage") {
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(state)); return;
      }
      const protocol = /\/(?:v1\/)?chat\/completions$/.test(request.url) ? "chat" :
        /\/(?:anthropic\/)?(?:v1\/)?messages$/.test(request.url) ? "messages" : null;
      if (request.method !== "POST" || !protocol) return reject(response, "benchmark_route", "Only the two metered model APIs are available");
      let bytes = 0, chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) throw new Error("Request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const effort = protocol === "chat" ? body.reasoning_effort : body.output_config?.effort;
      if (body.model !== model || effort !== "max" || body.thinking?.type !== "enabled") {
        state.rejected_before_dispatch++; persist();
        return reject(response, "benchmark_conditions", "Every attempt must explicitly use the fixed model and enabled Max effort");
      }
      if (body.max_tokens !== undefined && (!integer(body.max_tokens) || body.max_tokens < 1)) return reject(response, "benchmark_output", "Invalid output allowance");
      body.max_tokens = Math.min(body.max_tokens ?? maxOutputTokens, maxOutputTokens);
      body.temperature = 1.0; body.top_p = 1.0;
      if (protocol === "chat" && body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
      const serialized = JSON.stringify(body);
      const inputBound = Buffer.byteLength(serialized, "utf8") + 512;
      const reserve = inputBound + body.max_tokens;
      if (closing || state.stopped || state.attempts.length >= requestCap || state.spent_protected + state.held_tokens + reserve > tokenCap) {
        state.rejected_before_dispatch++; state.stopped = true;
        state.stop_reason = state.attempts.length >= requestCap ? "request_cap" : "token_cap";
        state.last_rejected_reservation = { input_bound: inputBound, output_bound: body.max_tokens, reserved: reserve,
          spent: state.spent_protected, held: state.held_tokens };
        persist(); return reject(response, "diagnostic_campaign_cap", "Trial budget cannot reserve another provider attempt");
      }
      const attempt = { id: state.attempts.length + 1, protocol, started_at: new Date().toISOString(),
        reserved: reserve, input_bound: inputBound, output_bound: body.max_tokens,
        model, effort, temperature: body.temperature, top_p: body.top_p,
        input_tokens: null, output_tokens: null, cached_input_tokens: 0, protected_tokens: null,
        usage_complete: false, terminal_event: false, http_status: null, returned_model: null };
      state.attempts.push(attempt); state.held_tokens += reserve; persist();
      let release;
      const settled = new Promise(resolve => { release = resolve; }); active.add(settled);
      let usage = {}, buffered = "", ordinaryJSON = "";
      const consume = event => {
        if (event === "[DONE]") { attempt.terminal_event = true; return; }
        let item;
        try { item = JSON.parse(event); } catch { return; }
        if (item.model) attempt.returned_model = item.model;
        if (item.message?.model) attempt.returned_model = item.message.model;
        if (item.message?.usage) Object.assign(usage, item.message.usage);
        if (item.usage) Object.assign(usage, item.usage);
        if (item.type === "message_stop") attempt.terminal_event = true;
        const finish = item.choices?.find(choice => choice.finish_reason)?.finish_reason || item.delta?.stop_reason || item.stop_reason;
        if (finish) attempt.finish_reason = finish;
      };
      try {
        const base = new URL(upstream);
        const prefix = base.pathname.replace(/\/$/, "").replace(/\/(?:(?:v1\/)?chat\/completions|anthropic(?:\/v1\/messages)?|v1)$/, "");
        base.pathname = protocol === "chat" ? prefix + "/chat/completions" : prefix + "/anthropic/v1/messages";
        base.search = ""; base.hash = "";
        const result = await fetchImpl(base, { method: "POST", redirect: "error",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`,
            "user-agent": "Neutrino-Framework-Comparison/1", ...(protocol === "messages" ? { "anthropic-version": "2023-06-01" } : {}) },
          body: serialized, ...(dispatcher ? { dispatcher } : {}), signal: AbortSignal.timeout(30 * 60_000) });
        attempt.http_status = result.status;
        if (!response.destroyed) response.writeHead(result.status, { "content-type": result.headers.get("content-type") || "application/json" });
        const streaming = result.headers.get("content-type")?.includes("text/event-stream");
        const decoder = new TextDecoder();
        // Finish draining a dispatched response after the agent disconnects: billing usage still matters.
        for await (const chunk of result.body || []) {
          if (!response.destroyed) response.write(chunk);
          const text = decoder.decode(chunk, { stream: true });
          if (streaming) {
            buffered += text;
            let boundary;
            while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
              const frame = buffered.slice(0, boundary.index); buffered = buffered.slice(boundary.index + boundary[0].length);
              const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (data) consume(data);
            }
          } else ordinaryJSON += text;
        }
        if (!streaming) { consume(ordinaryJSON); attempt.terminal_event = result.ok; }
        if (!response.destroyed) response.end();
      } catch (error) {
        attempt.error = error.name || "transport_failure";
        if (!response.destroyed) response.destroy();
      } finally {
        if (protocol === "chat") {
          if (integer(usage.prompt_tokens)) attempt.input_tokens = usage.prompt_tokens;
          if (integer(usage.completion_tokens)) attempt.output_tokens = usage.completion_tokens;
          attempt.cached_input_tokens = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
        } else {
          if (integer(usage.input_tokens)) attempt.input_tokens = usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
          if (integer(usage.output_tokens)) attempt.output_tokens = usage.output_tokens;
          attempt.cached_input_tokens = usage.cache_read_input_tokens || 0;
        }
        attempt.usage_complete = attempt.terminal_event && attempt.http_status >= 200 && attempt.http_status < 300 &&
          integer(attempt.input_tokens) && integer(attempt.output_tokens);
        attempt.protected_tokens = attempt.usage_complete ? attempt.input_tokens + attempt.output_tokens : reserve;
        state.held_tokens -= reserve; state.spent_protected += attempt.protected_tokens;
        state.input_tokens += attempt.input_tokens ?? 0; state.output_tokens += attempt.output_tokens ?? 0;
        state.cached_input_tokens += attempt.cached_input_tokens;
        if (!attempt.usage_complete) state.unknown_requests++;
        if (attempt.protected_tokens > reserve) { state.stopped = true; state.stop_reason = "provider_exceeded_reservation"; }
        if (attempt.http_status === 402) { state.stopped = true; state.stop_reason = "provider_balance"; }
        attempt.finished_at = new Date().toISOString();
        try { persist(); } finally { active.delete(settled); release(); }
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) reject(response, "benchmark_invalid_request", "Gateway could not validate or persist this attempt");
      else if (!response.destroyed) response.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
  return { state, url: `http://127.0.0.1:${server.address().port}`, async close() {
    closing = true;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
    await Promise.all([...active]);
    state.finished_at = new Date().toISOString(); persist(); await dispatcher?.close();
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--secret");
  if (index < 0) throw new Error("--secret is required");
  const input = JSON.parse(fs.readFileSync(process.argv[index + 1], "utf8"));
  const gateway = await createTokenGateway({ ...input, proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY });
  fs.writeFileSync(input.readyFile, JSON.stringify({ url: gateway.url, pid: process.pid }) + "\n");
  const stop = async () => { await gateway.close(); process.exit(0); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
