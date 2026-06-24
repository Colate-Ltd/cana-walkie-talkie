import { config } from "./config.js";
import { getChannel, insertMessage, nextSeq, recentMessages } from "./db.js";
import { deliverMessage } from "./broadcaster.js";
import { scanForSecretLevel } from "./secret-scan.js";
import type { WireMessage } from "./types.js";

export interface EmitInput {
  channelId: string;
  from: string;
  fromTokenId: string | null;
  to?: string | null;
  private?: boolean;
  body: unknown;
}

export type EmitResult =
  | { ok: true; message: WireMessage }
  | { ok: false; code: "channel_closed" | "too_large" | "secret_blocked"; message: string };

/**
 * Validate, persist, and broadcast one message. Single choke point so REST
 * and WebSocket senders share identical seq assignment, secret-scanning, and
 * delivery semantics.
 */
export function emitMessage(input: EmitInput): EmitResult {
  const channel = getChannel(input.channelId);
  if (!channel || channel.status !== "active") {
    return { ok: false, code: "channel_closed", message: "channel is closed or missing" };
  }

  const raw = JSON.stringify(input.body ?? null);
  if (Buffer.byteLength(raw, "utf8") > config.maxBodyBytes) {
    return { ok: false, code: "too_large", message: `message body exceeds ${config.maxBodyBytes} bytes` };
  }

  // Block high-confidence credentials from being broadcast to the channel.
  if (scanForSecretLevel(input.body) === "high") {
    return { ok: false, code: "secret_blocked", message: "message looks like it contains a secret and was blocked" };
  }

  const isPrivate = !!input.private && !!input.to;
  const seq = nextSeq(channel.id);
  const stored = insertMessage({
    channelId: channel.id,
    seq,
    kind: "message",
    senderLabel: input.from,
    senderTokenId: input.fromTokenId,
    recipient: input.to ?? null,
    private: isPrivate,
    body: input.body,
  });

  const frame: WireMessage = {
    v: 1,
    type: "message",
    channelId: channel.id,
    seq: stored.seq,
    from: input.from,
    fromTokenId: input.fromTokenId,
    to: input.to ?? null,
    private: isPrivate,
    ts: new Date(stored.createdAt).toISOString(),
    body: input.body,
  };

  deliverMessage(frame);
  return { ok: true, message: frame };
}

/** Build the replay `history` payload visible to a given handle. */
export function historyFor(channelId: string, handle: string): WireMessage[] {
  const rows = recentMessages(channelId, config.historyReplay);
  const out: WireMessage[] = [];
  for (const m of rows) {
    // Private messages only replay to their sender/recipient.
    if (m.private && handle !== m.senderLabel && handle !== m.recipient) continue;
    out.push({
      v: 1,
      type: "message",
      channelId: m.channelId,
      seq: m.seq,
      from: m.senderLabel,
      fromTokenId: m.senderTokenId,
      to: m.recipient,
      private: m.private,
      ts: new Date(m.createdAt).toISOString(),
      body: m.body,
    });
  }
  return out;
}
