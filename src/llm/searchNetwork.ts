import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { Agent, ProxyAgent, type Dispatcher } from "undici";

interface ProxySettings {
  http: string;
  https: string;
  bypass: string;
  explicit: boolean;
}

const CONNECT_OPTIONS = { timeout: 2500, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 };
let windowsProxy: { until: number; value: Promise<ProxySettings | null> } | undefined;

/** Match standard proxy exclusions, including the wildcard patterns used by Windows. */
export function bypassSearchProxy(url: URL, rules: string): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return rules.toLowerCase().split(/[,;\s]+/).filter(Boolean).some((rule) => {
    if (rule === "*") return true;
    if (rule === "<local>") return !host.includes(".") && !host.includes(":");
    const match = rule.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!match || (match[2] && match[2] !== port)) return false;
    const pattern = match[1];
    if (pattern.startsWith(".")) return host === pattern.slice(1) || host.endsWith(pattern);
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(host);
  });
}

/** Search-local dispatchers: honor proxies on Node 18 without changing global fetch or DNS. */
export async function createSearchTransport() {
  const settings = await proxySettings();
  const direct = new Agent({ connect: CONNECT_OPTIONS });
  const proxies = new Map<string, ProxyAgent>();
  const brokenProxies = new Set<string>();
  const fingerprint = createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 16);
  const dispatcherFor = (url: URL): Dispatcher => {
    const proxy = url.protocol === "https:" ? settings.https : settings.http;
    if (!proxy || brokenProxies.has(proxy) || bypassSearchProxy(url, settings.bypass)) return direct;
    let dispatcher = proxies.get(proxy);
    if (!dispatcher) {
      const parsed = new URL(proxy);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("Search proxy must use an http:// or https:// URL");
      dispatcher = new ProxyAgent({
        uri: proxy,
        connect: CONNECT_OPTIONS,
        proxyTls: CONNECT_OPTIONS,
        requestTls: CONNECT_OPTIONS,
      });
      proxies.set(proxy, dispatcher);
    }
    return dispatcher;
  };
  return {
    fingerprint,
    async fetch(url: URL, init: RequestInit): Promise<Response> {
      const dispatcher = dispatcherFor(url);
      try {
        return await fetch(url, { ...init, dispatcher } as RequestInit);
      } catch (error) {
        // A stale environment/system proxy must not disable reachable domestic sources.
        // An explicit NEUTRINO_SEARCH_PROXY is authoritative and is never bypassed.
        const cause = error instanceof Error ? error.cause as { code?: string; hostname?: string; address?: string; port?: number; message?: string } | undefined : undefined;
        const proxy = url.protocol === "https:" ? settings.https : settings.http;
        const endpoint = proxy ? new URL(proxy) : null;
        const host = endpoint?.hostname.replace(/^\[|\]$/g, "") ?? "";
        const port = endpoint?.port || (endpoint?.protocol === "https:" ? "443" : "80");
        const proxyAddress = cause?.hostname === host || cause?.address === host ||
          (host === "localhost" && ["127.0.0.1", "::1"].includes(cause?.address ?? ""));
        const timedOutAtProxy = cause?.code === "UND_ERR_CONNECT_TIMEOUT" && cause.message?.includes(`${host}:${port}`);
        const failedAtProxy = (proxyAddress && (!cause?.port || String(cause.port) === port)) || timedOutAtProxy;
        if (!settings.explicit && dispatcher !== direct && !init.signal?.aborted &&
            failedAtProxy && /^(ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT)$/.test(cause?.code ?? "")) {
          brokenProxies.add(proxy);
          return fetch(url, { ...init, dispatcher: direct } as RequestInit);
        }
        throw error;
      }
    },
    async close(): Promise<void> {
      await Promise.allSettled([direct.destroy(), ...[...proxies.values()].map((agent) => agent.destroy())]);
    },
  };
}

async function proxySettings(): Promise<ProxySettings> {
  const override = process.env.NEUTRINO_SEARCH_PROXY?.trim();
  if (override) {
    const proxy = override.toLowerCase() === "direct" ? "" : override;
    if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error("NEUTRINO_SEARCH_PROXY must be an HTTP(S) proxy URL or direct");
    return { http: proxy, https: proxy, bypass: "", explicit: true };
  }
  const all = process.env.all_proxy || process.env.ALL_PROXY || "";
  const http = process.env.http_proxy ?? process.env.HTTP_PROXY ?? all;
  const https = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? http;
  const bypass = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
  if (http || https) return { http, https, bypass, explicit: false };
  const native = await systemProxySettings();
  return native ? { ...native, bypass: bypass || native.bypass } : { http: "", https: "", bypass, explicit: false };
}

/** Read static Windows proxy settings, also when started inside WSL. No machine settings are changed. */
function systemProxySettings(): Promise<ProxySettings | null> {
  if (process.platform !== "win32" && !(process.platform === "linux" && process.env.WSL_INTEROP)) return Promise.resolve(null);
  if (windowsProxy && windowsProxy.until > Date.now()) return windowsProxy.value;
  const value = new Promise<ProxySettings | null>((resolve) => {
    const command = process.platform === "win32" ? "reg.exe" : "powershell.exe";
    const query = ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"];
    const args = process.platform === "win32" ? query : [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "reg.exe query 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'",
    ];
    execFile(command, args, { timeout: 1200, maxBuffer: 32_000, windowsHide: true }, (error, stdout) => {
      if (error || !/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(stdout)) { resolve(null); return; }
      const server = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() ?? "";
      const bypass = stdout.match(/ProxyOverride\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() ?? "";
      const parts = Object.fromEntries(server.split(";").filter((part) => part.includes("=")).map((part) => part.split("=")));
      const normalize = (address: string) => address && (/^\w+:\/\//.test(address) ? address : `http://${address}`);
      const http = normalize(parts.http || (server.includes("=") ? "" : server));
      const https = normalize(parts.https || parts.http || (server.includes("=") ? "" : server));
      resolve(http || https ? { http, https, bypass, explicit: false } : null);
    });
  });
  windowsProxy = { until: Date.now() + 60_000, value };
  return value;
}
