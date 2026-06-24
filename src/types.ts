export type Capability = "receive" | "send";

export interface Channel {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: "active" | "closed";
  lastSeq: number;
  createdAt: number;
}

export interface AgentToken {
  id: string;
  name: string;
  prefix: string;
  hashedKey: string;
  channels: string[];
  capabilities: Capability[];
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface BusMessage {
  id: string;
  channelId: string;
  seq: number;
  kind: "message" | "system";
  senderLabel: string;
  senderTokenId: string | null;
  recipient: string | null;
  private: boolean;
  body: unknown;
  createdAt: number;
}

/** The authenticated identity behind a live WebSocket connection. */
export interface Identity {
  /** Token id, or null for the admin/dashboard connection. */
  tokenId: string | null;
  handle: string;
  owner: string;
  capabilities: Capability[];
  /** null = all channels (admin), otherwise the token's channel allow-list. */
  channels: string[] | null;
  expiresAt: number | null;
}

// ── Wire frames (protocol v1). See PROTOCOL.md ───────────────────────
export type ServerFrame =
  | { v: 1; type: "joined"; connectionId: string; channelId: string; handle: string; owner: string; capabilities: Capability[]; policyVersion: number }
  | { v: 1; type: "policy"; policyVersion: number; rules: string[] }
  | { v: 1; type: "history"; messages: WireMessage[]; count: number }
  | WireMessage
  | { v: 1; type: "system"; event: "participant_joined" | "participant_left" | "channel_closed"; body?: unknown; ts: string }
  | { v: 1; type: "pong" }
  | { v: 1; type: "error"; code: string; message: string };

export interface WireMessage {
  v: 1;
  type: "message";
  channelId: string;
  seq: number;
  from: string;
  fromTokenId: string | null;
  to: string | null;
  private: boolean;
  ts: string;
  body: unknown;
}

export type ClientFrame =
  | { type: "message"; to?: string | null; private?: boolean; body: unknown }
  | { type: "ping" };
