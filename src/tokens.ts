import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Agent tokens are opaque `wtk_…` strings. We store ONLY a SHA-256 hash
 * (peppered with AGENT_TOKEN_PEPPER), never the raw token. The raw value
 * is shown exactly once at mint time.
 */
export function generateAgentToken(): { raw: string; prefix: string; hash: string } {
  const raw = "wtk_" + crypto.randomBytes(32).toString("base64url");
  return { raw, prefix: raw.slice(0, 12), hash: hashAgentToken(raw) };
}

export function hashAgentToken(raw: string): string {
  return crypto.createHash("sha256").update(raw + config.tokenPepper).digest("hex");
}

/** Constant-time compare for the admin bearer token. */
export function adminTokenMatches(presented: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
