import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "./errors.js";

// Two principals:
// - "connector": Bearer CONNECTOR_TOKEN. Read and write. Only the local MCP connector has it.
// - "viewer": a signed session cookie from the viewer login. Read-only; write routes reject it.

export type Principal = "connector" | "viewer";

const COOKIE = "tv_session";
const SESSION_DAYS = 30;

export interface AuthConfig {
  connectorToken: string;
  viewerPassword?: string;
  sessionSecret?: string;
  secureCookies?: boolean;
}

export function principalOf(req: FastifyRequest, cfg: AuthConfig): Principal | null {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return safeEqual(header.slice(7), cfg.connectorToken) ? "connector" : null;
  }
  const token = readCookie(req.headers.cookie, COOKIE);
  if (token && cfg.sessionSecret && verifySession(token, cfg.sessionSecret)) return "viewer";
  return null;
}

/** Reads: connector or viewer. */
export function requireReader(req: FastifyRequest, cfg: AuthConfig): Principal {
  const p = principalOf(req, cfg);
  if (!p) throw new HttpError(401, "unauthorized", "sign in to the viewer, or use the connector token");
  return p;
}

/** Writes: connector only. A viewer session is valid but read-only, so it gets 403. */
export function requireWriter(req: FastifyRequest, cfg: AuthConfig) {
  const p = principalOf(req, cfg);
  if (p === "viewer") throw new HttpError(403, "read_only", "the viewer is read-only; changes are made in Claude Desktop");
  if (p !== "connector") throw new HttpError(401, "unauthorized", "a valid connector token is required");
}

export function issueSession(reply: FastifyReply, cfg: AuthConfig) {
  if (!cfg.sessionSecret) throw new HttpError(503, "viewer_disabled", "viewer login is not configured");
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = Buffer.from(JSON.stringify({ scope: "read", exp })).toString("base64url");
  const value = `${payload}.${sign(payload, cfg.sessionSecret)}`;
  reply.header(
    "set-cookie",
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${cfg.secureCookies ? "; Secure" : ""}`,
  );
}

export function clearSession(reply: FastifyReply, cfg: AuthConfig) {
  reply.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.secureCookies ? "; Secure" : ""}`);
}

export function checkPassword(given: string, cfg: AuthConfig): boolean {
  return !!cfg.viewerPassword && safeEqual(given, cfg.viewerPassword);
}

function verifySession(token: string, secret: string): boolean {
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload, secret))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { scope?: string; exp?: number };
    return data.scope === "read" && typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Small in-memory limiter for the login route: N attempts per window per IP. */
export class LoginLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private max = 10,
    private windowMs = 15 * 60_000,
  ) {}
  allow(ip: string): boolean {
    const now = Date.now();
    const h = this.hits.get(ip);
    if (!h || h.reset < now) {
      this.hits.set(ip, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}
