import type { ServerFrame, WireMessage } from "./types.js";

/**
 * Single-node, in-memory message broadcaster. Tracks live connections per
 * channel and fans frames out to them, honouring directed/private routing.
 *
 * This is the open-source core's deliberate scaling boundary: it works great
 * on one process. The hosted Cana product swaps this for a Redis pub/sub
 * broadcaster so connections can span many replicas. The interface is kept
 * small on purpose so that swap is a drop-in.
 */
export interface Connection {
  id: string;
  channelId: string;
  handle: string;
  /** null for the admin/dashboard connection. */
  tokenId: string | null;
  send: (frame: ServerFrame) => void;
  close: (code: number, reason: string) => void;
}

const byChannel = new Map<string, Map<string, Connection>>();

export function addConnection(conn: Connection): void {
  let set = byChannel.get(conn.channelId);
  if (!set) {
    set = new Map();
    byChannel.set(conn.channelId, set);
  }
  set.set(conn.id, conn);
}

export function removeConnection(channelId: string, connId: string): void {
  const set = byChannel.get(channelId);
  if (!set) return;
  set.delete(connId);
  if (set.size === 0) byChannel.delete(channelId);
}

export function connectionCount(channelId: string): number {
  return byChannel.get(channelId)?.size ?? 0;
}

export function participants(channelId: string): Array<{ id: string; handle: string; tokenId: string | null }> {
  const set = byChannel.get(channelId);
  if (!set) return [];
  return [...set.values()].map((c) => ({ id: c.id, handle: c.handle, tokenId: c.tokenId }));
}

/** True if `frame` should be visible to a connection with `handle`. */
function visibleTo(frame: WireMessage, handle: string): boolean {
  if (!frame.private) return true; // public + directed-but-not-private are visible to all
  // private: only the sender and the addressed recipient can see it
  return handle === frame.from || handle === frame.to;
}

/** Fan a message frame out to every eligible live connection on its channel. */
export function deliverMessage(frame: WireMessage): void {
  const set = byChannel.get(frame.channelId);
  if (!set) return;
  for (const conn of set.values()) {
    if (visibleTo(frame, conn.handle)) conn.send(frame);
  }
}

/** Fan a non-message system frame out to everyone on the channel. */
export function deliverSystem(channelId: string, frame: ServerFrame): void {
  const set = byChannel.get(channelId);
  if (!set) return;
  for (const conn of set.values()) conn.send(frame);
}

/** Close every connection on a channel (used when a channel is killed). */
export function closeChannelConnections(channelId: string, code = 4002, reason = "channel_closed"): void {
  const set = byChannel.get(channelId);
  if (!set) return;
  for (const conn of [...set.values()]) conn.close(code, reason);
  byChannel.delete(channelId);
}

/** Close all live connections belonging to a revoked token. */
export function closeTokenConnections(tokenId: string, code = 4003, reason = "token_revoked"): void {
  for (const set of byChannel.values()) {
    for (const conn of [...set.values()]) {
      if (conn.tokenId === tokenId) conn.close(code, reason);
    }
  }
}
