import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { config } from "./config.js";
import type { AgentToken, BusMessage, Channel, Capability } from "./types.js";

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id          TEXT PRIMARY KEY,
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    last_seq    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    hashed_key   TEXT UNIQUE NOT NULL,
    channels     TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    expires_at   INTEGER,
    revoked_at   INTEGER,
    last_used_at INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(hashed_key);

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'message',
    sender_label    TEXT NOT NULL,
    sender_token_id TEXT,
    recipient       TEXT,
    private         INTEGER NOT NULL DEFAULT 0,
    body            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    UNIQUE(channel_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, seq);
`);

const newId = (p: string) => `${p}_${crypto.randomBytes(12).toString("hex")}`;

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "channel";
  // ensure uniqueness
  let slug = base;
  let n = 1;
  while (db.prepare("SELECT 1 FROM channels WHERE slug = ?").get(slug)) {
    slug = `${base}-${++n}`;
  }
  return slug;
}

// ── Channels ─────────────────────────────────────────────────────────
function rowToChannel(r: Record<string, unknown>): Channel {
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    status: r.status as Channel["status"],
    lastSeq: Number(r.last_seq),
    createdAt: Number(r.created_at),
  };
}

export function createChannel(name: string, description?: string): Channel {
  const id = newId("ch");
  const slug = slugify(name);
  const now = Date.now();
  db.prepare(
    "INSERT INTO channels (id, slug, name, description, status, last_seq, created_at) VALUES (?,?,?,?, 'active', 0, ?)",
  ).run(id, slug, name, description ?? null, now);
  return rowToChannel(db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Record<string, unknown>);
}

export function listChannels(): Channel[] {
  return (db.prepare("SELECT * FROM channels ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(rowToChannel);
}

export function getChannel(id: string): Channel | null {
  const r = db.prepare("SELECT * FROM channels WHERE id = ? OR slug = ?").get(id, id) as Record<string, unknown> | undefined;
  return r ? rowToChannel(r) : null;
}

export function closeChannel(id: string): void {
  db.prepare("UPDATE channels SET status = 'closed' WHERE id = ?").run(id);
}

/** Atomically increment and return the next per-channel sequence number. */
export function nextSeq(channelId: string): number {
  db.prepare("UPDATE channels SET last_seq = last_seq + 1 WHERE id = ?").run(channelId);
  const r = db.prepare("SELECT last_seq FROM channels WHERE id = ?").get(channelId) as { last_seq: number } | undefined;
  return r ? Number(r.last_seq) : 0;
}

// ── Tokens ───────────────────────────────────────────────────────────
function rowToToken(r: Record<string, unknown>): AgentToken {
  return {
    id: r.id as string,
    name: r.name as string,
    prefix: r.prefix as string,
    hashedKey: r.hashed_key as string,
    channels: JSON.parse(r.channels as string),
    capabilities: JSON.parse(r.capabilities as string),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    createdAt: Number(r.created_at),
  };
}

export function insertToken(t: {
  name: string;
  prefix: string;
  hashedKey: string;
  channels: string[];
  capabilities: Capability[];
  expiresAt: number | null;
}): AgentToken {
  const id = newId("tok");
  const now = Date.now();
  db.prepare(
    "INSERT INTO tokens (id, name, prefix, hashed_key, channels, capabilities, expires_at, revoked_at, last_used_at, created_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?)",
  ).run(id, t.name, t.prefix, t.hashedKey, JSON.stringify(t.channels), JSON.stringify(t.capabilities), t.expiresAt, now);
  return rowToToken(db.prepare("SELECT * FROM tokens WHERE id = ?").get(id) as Record<string, unknown>);
}

export function listTokens(): AgentToken[] {
  return (db.prepare("SELECT * FROM tokens ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(rowToToken);
}

export function getTokenByHash(hash: string): AgentToken | null {
  const r = db.prepare("SELECT * FROM tokens WHERE hashed_key = ?").get(hash) as Record<string, unknown> | undefined;
  return r ? rowToToken(r) : null;
}

export function getTokenById(id: string): AgentToken | null {
  const r = db.prepare("SELECT * FROM tokens WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToToken(r) : null;
}

export function revokeToken(id: string): boolean {
  const res = db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  return res.changes > 0;
}

export function touchToken(id: string): void {
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}

// ── Messages ─────────────────────────────────────────────────────────
function rowToMessage(r: Record<string, unknown>): BusMessage {
  return {
    id: r.id as string,
    channelId: r.channel_id as string,
    seq: Number(r.seq),
    kind: r.kind as BusMessage["kind"],
    senderLabel: r.sender_label as string,
    senderTokenId: (r.sender_token_id as string | null) ?? null,
    recipient: (r.recipient as string | null) ?? null,
    private: Number(r.private) === 1,
    body: JSON.parse(r.body as string),
    createdAt: Number(r.created_at),
  };
}

export function insertMessage(m: Omit<BusMessage, "id" | "createdAt"> & { createdAt?: number }): BusMessage {
  const id = newId("msg");
  const createdAt = m.createdAt ?? Date.now();
  db.prepare(
    "INSERT INTO messages (id, channel_id, seq, kind, sender_label, sender_token_id, recipient, private, body, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, m.channelId, m.seq, m.kind, m.senderLabel, m.senderTokenId, m.recipient, m.private ? 1 : 0, JSON.stringify(m.body), createdAt);
  return rowToMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown>);
}

/** Most recent `limit` messages for a channel, oldest-first. */
export function recentMessages(channelId: string, limit: number): BusMessage[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ?")
    .all(channelId, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage).reverse();
}

export function messageCounts(channelId: string): number {
  const r = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?").get(channelId) as { c: number };
  return Number(r.c);
}

export { db };
