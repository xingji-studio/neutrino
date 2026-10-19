import crypto from "node:crypto";
import { promisify } from "node:util";
import type http from "node:http";
import { loadConfig, saveConfig } from "../config.js";

export const DEFAULT_WEB_PASSWORD = "114514";
const COOKIE = "neutrino_session";
const MAX_AGE = 365 * 24 * 60 * 60;
const scrypt = promisify(crypto.scrypt);

export function validateWebPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || !password.trim() || password.length > 256) {
    throw new Error("Password must contain 1–256 characters and cannot be blank.");
  }
}

/** Only a salted password hash is persisted; settings never return it. */
export function hashWebPassword(password: unknown): string {
  validateWebPassword(password);
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function passwordHash(): string {
  const config = loadConfig();
  if (typeof config.web_password_hash === "string" && config.web_password_hash) return config.web_password_hash;
  const hash = hashWebPassword(DEFAULT_WEB_PASSWORD);
  config.web_password_hash = hash;
  saveConfig(config);
  return hash;
}

function signature(value: string, hash: string): string {
  return crypto.createHmac("sha256", hash).update(value).digest("base64url");
}

function matches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Signed cookies survive restarts, but a password change invalidates all of them. */
export class WebAuth {
  constructor(readonly enabled: boolean) {
    if (enabled) passwordHash();
  }

  authenticated(req: http.IncomingMessage): boolean {
    if (!this.enabled) return true;
    const value = req.headers.cookie?.split(";").map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!value) return false;
    const [expires, nonce, mac, extra] = value.split(".");
    if (extra !== undefined || !/^\d+$/.test(expires) || !nonce || !mac || Number(expires) <= Date.now()) return false;
    return matches(mac, signature(`${expires}.${nonce}`, passwordHash()));
  }

  async login(password: unknown): Promise<boolean> {
    if (!this.enabled) return true;
    try { validateWebPassword(password); } catch { return false; }
    const hash = passwordHash();
    const [kind, salt, expected] = hash.split(":");
    if (kind !== "scrypt" || !salt || !expected) return false;
    const derived = await scrypt(password as string, salt, 64) as Buffer;
    // A concurrent settings change must not issue a session for the old password.
    return hash === passwordHash() && matches(derived.toString("hex"), expected);
  }

  remember(res: http.ServerResponse): void {
    if (!this.enabled) return;
    const value = `${Date.now() + MAX_AGE * 1000}.${crypto.randomBytes(24).toString("base64url")}`;
    res.setHeader("Set-Cookie", `${COOKIE}=${value}.${signature(value, passwordHash())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}`);
  }

  forget(res: http.ServerResponse): void {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }
}
