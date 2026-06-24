import crypto from "node:crypto";

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// A generated admin token if none was provided. Printed once at startup.
let adminToken = process.env.ADMIN_TOKEN?.trim() || "";
let adminTokenGenerated = false;
if (!adminToken) {
  adminToken = "adm_" + crypto.randomBytes(24).toString("base64url");
  adminTokenGenerated = true;
}

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: num("PORT", 8787),
  dbPath: process.env.DB_PATH ?? "./walkie.db",
  adminToken,
  adminTokenGenerated,
  tokenPepper: process.env.AGENT_TOKEN_PEPPER ?? "",
  historyReplay: Math.max(1, num("HISTORY_REPLAY", 100)),
  maxBodyBytes: Math.max(1024, num("MAX_BODY_BYTES", 256 * 1024)),
  defaultTtlMs: Math.max(1, num("DEFAULT_TTL_HOURS", 8)) * 3600_000,
  maxTtlMs: Math.max(1, num("MAX_TTL_HOURS", 168)) * 3600_000,
  allowedOrigins: list("BUS_ALLOWED_ORIGINS"),
} as const;

// Open-source guardrails. These are the deliberate limits of the community
// core — the hosted Cana product lifts them (multi-node scale, org RBAC,
// audit, push, attachments, SSO). See README "Cana vs the open-source core".
export const limits = {
  capabilities: ["receive", "send"] as const, // no `admin` / `act` in OSS
  perConnRatePerSec: 8,
  maxConnectionsPerChannel: 200,
} as const;
