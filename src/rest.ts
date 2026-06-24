import { Router } from "express";
import { z } from "zod";
import { config, limits } from "./config.js";
import { requireAdmin } from "./auth.js";
import { generateAgentToken } from "./tokens.js";
import {
  closeChannel,
  createChannel,
  getChannel,
  insertToken,
  listChannels,
  listTokens,
  messageCounts,
  recentMessages,
  revokeToken,
} from "./db.js";
import { connectionCount, participants, closeChannelConnections, closeTokenConnections } from "./broadcaster.js";
import { emitMessage } from "./messages.js";
import { POLICY_VERSION } from "./policy.js";

export const rest = Router();
rest.use(requireAdmin);

// ── Meta ─────────────────────────────────────────────────────────────
rest.get("/meta", (_req, res) => {
  res.json({ protocolVersion: 1, policyVersion: POLICY_VERSION, capabilities: limits.capabilities });
});

// ── Channels ─────────────────────────────────────────────────────────
const createChannelSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

rest.post("/channels", (req, res) => {
  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid", details: parsed.error.flatten() });
    return;
  }
  const ch = createChannel(parsed.data.name, parsed.data.description);
  res.status(201).json(ch);
});

rest.get("/channels", (_req, res) => {
  const channels = listChannels().map((c) => ({
    ...c,
    liveConnections: connectionCount(c.id),
    messageCount: messageCounts(c.id),
  }));
  res.json({ channels });
});

rest.get("/channels/:id", (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ...ch, participants: participants(ch.id), liveConnections: connectionCount(ch.id) });
});

rest.post("/channels/:id/kill", (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  closeChannel(ch.id);
  closeChannelConnections(ch.id);
  res.json({ ok: true });
});

// ── Messages ─────────────────────────────────────────────────────────
rest.get("/channels/:id/messages", (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const messages = recentMessages(ch.id, limit);
  res.json({ messages });
});

const sendSchema = z.object({
  body: z.unknown(),
  to: z.string().max(48).nullish(),
  private: z.boolean().optional(),
});

rest.post("/channels/:id/messages", (req, res) => {
  const ch = getChannel(req.params.id);
  if (!ch) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid", details: parsed.error.flatten() });
    return;
  }
  const result = emitMessage({
    channelId: ch.id,
    from: "dashboard",
    fromTokenId: null,
    to: parsed.data.to ?? null,
    private: parsed.data.private,
    body: parsed.data.body,
  });
  if (!result.ok) {
    res.status(result.code === "secret_blocked" ? 422 : 409).json({ error: result.code, message: result.message });
    return;
  }
  res.status(201).json(result.message);
});

// ── Tokens ───────────────────────────────────────────────────────────
const mintSchema = z.object({
  name: z.string().min(1).max(48),
  channels: z.array(z.string()).min(1),
  capabilities: z.array(z.enum(["receive", "send"])).min(1),
  ttlHours: z.number().positive().optional(),
});

rest.post("/tokens", (req, res) => {
  const parsed = mintSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid", details: parsed.error.flatten() });
    return;
  }
  // Validate channels exist.
  for (const cid of parsed.data.channels) {
    if (!getChannel(cid)) {
      res.status(400).json({ error: "unknown_channel", channel: cid });
      return;
    }
  }
  const ttlMs = parsed.data.ttlHours != null ? parsed.data.ttlHours * 3600_000 : config.defaultTtlMs;
  const expiresAt = Date.now() + Math.min(ttlMs, config.maxTtlMs);
  const { raw, prefix, hash } = generateAgentToken();
  const token = insertToken({
    name: parsed.data.name,
    prefix,
    hashedKey: hash,
    channels: parsed.data.channels,
    capabilities: parsed.data.capabilities,
    expiresAt,
  });
  // `key` is returned exactly once and never stored or shown again.
  res.status(201).json({ ...publicToken(token), key: raw });
});

rest.get("/tokens", (_req, res) => {
  res.json({ tokens: listTokens().map(publicToken) });
});

rest.delete("/tokens/:id", (req, res) => {
  const ok = revokeToken(req.params.id);
  if (ok) closeTokenConnections(req.params.id);
  res.json({ ok });
});

function publicToken(t: ReturnType<typeof listTokens>[number]) {
  const status = t.revokedAt ? "revoked" : t.expiresAt && t.expiresAt <= Date.now() ? "expired" : "active";
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    channels: t.channels,
    capabilities: t.capabilities,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    createdAt: t.createdAt,
    status,
  };
}
