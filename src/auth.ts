import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { adminTokenMatches, hashAgentToken } from "./tokens.js";
import { getTokenByHash, getTokenById, touchToken } from "./db.js";
import type { Capability, Identity } from "./types.js";

/** Express middleware: require the admin bearer token on REST/dashboard APIs. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!presented || !adminTokenMatches(presented)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export type WsAuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; code: string; message: string };

function sanitizeHandle(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9 _.-]/g, "").slice(0, 48) || "agent";
}

/**
 * Resolve a raw WebSocket credential into an Identity. Accepts either:
 *  - an agent token (`wtk_…`)  → scoped to its channels + capabilities
 *  - the admin token           → full receive+send on any channel (dashboard)
 */
export function resolveWsIdentity(rawToken: string, channelId: string): WsAuthResult {
  if (!rawToken) return { ok: false, code: "no_token", message: "missing token" };

  // Admin / dashboard connection.
  if (adminTokenMatches(rawToken)) {
    return {
      ok: true,
      identity: {
        tokenId: null,
        handle: "dashboard",
        owner: "admin",
        capabilities: ["receive", "send"],
        channels: null,
        expiresAt: null,
      },
    };
  }

  // Agent token.
  if (!rawToken.startsWith("wtk_")) {
    return { ok: false, code: "bad_token", message: "unrecognized token" };
  }
  const token = getTokenByHash(hashAgentToken(rawToken));
  if (!token) return { ok: false, code: "bad_token", message: "invalid token" };
  if (token.revokedAt != null) return { ok: false, code: "revoked", message: "token revoked" };
  if (token.expiresAt != null && token.expiresAt <= Date.now()) {
    return { ok: false, code: "expired", message: "token expired" };
  }
  if (!token.channels.includes(channelId)) {
    return { ok: false, code: "forbidden", message: "token not scoped to this channel" };
  }
  touchToken(token.id);
  return {
    ok: true,
    identity: {
      tokenId: token.id,
      handle: sanitizeHandle(token.name),
      owner: "token:" + token.prefix,
      capabilities: token.capabilities as Capability[],
      channels: token.channels,
      expiresAt: token.expiresAt,
    },
  };
}

/** Re-check a still-connected agent token for mid-stream expiry/revocation. */
export function tokenStillValid(tokenId: string | null): boolean {
  if (tokenId == null) return true; // admin/dashboard connection never expires
  const token = getTokenById(tokenId);
  if (!token) return false;
  if (token.revokedAt != null) return false;
  if (token.expiresAt != null && token.expiresAt <= Date.now()) return false;
  return true;
}

void config; // imported for side effects / future configuration use
