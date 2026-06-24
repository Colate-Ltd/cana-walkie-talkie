/**
 * End-to-end smoke test: boots the real server in-process against a throwaway
 * SQLite file, then exercises the full path — create channel → mint token →
 * agent connects over WebSocket → handshake frames → send a message → a second
 * (dashboard) connection receives it. Run with `npm test`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "smoke.db");
for (const f of [DB, DB + "-wal", DB + "-shm", DB + "-journal"]) fs.rmSync(f, { force: true });

const PORT = 8799;
const ADMIN = "adm_test_token_smoke";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.DB_PATH = DB;
process.env.ADMIN_TOKEN = ADMIN;
process.env.AGENT_TOKEN_PEPPER = "smoke-pepper";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}`);
  if (!cond) failures++;
}

const BASE = `http://127.0.0.1:${PORT}`;
const adminFetch = (p: string, opts: RequestInit = {}) =>
  fetch(`${BASE}/api/bus${p}`, { ...opts, headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}`, ...(opts.headers as Record<string, string>) } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Buffering frame reader: the server sends several frames back-to-back on
 * connect, so we queue every frame and let `next(type)` match against the
 * queue (or wait for a future frame). Avoids the per-listener race where
 * frames arriving between awaits get dropped.
 */
function reader(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: Array<{ type: string; resolve: (f: any) => void; timer: NodeJS.Timeout }> = [];
  ws.on("message", (data: Buffer) => {
    const f = JSON.parse(data.toString());
    const wi = waiters.findIndex((w) => w.type === f.type);
    if (wi >= 0) {
      const w = waiters.splice(wi, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(f);
    } else {
      queue.push(f);
    }
  });
  return {
    next(type: string, timeoutMs = 3000): Promise<any> {
      const qi = queue.findIndex((f) => f.type === type);
      if (qi >= 0) return Promise.resolve(queue.splice(qi, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const wi = waiters.findIndex((w) => w.resolve === resolve);
          if (wi >= 0) waiters.splice(wi, 1);
          reject(new Error(`timeout waiting for ${type}`));
        }, timeoutMs);
        waiters.push({ type, resolve, timer });
      });
    },
  };
}

async function main() {
  await import("../src/server.js"); // boots + listens
  // Wait for the server to accept connections.
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  check("health endpoint up", (await fetch(`${BASE}/healthz`)).ok);

  // Auth is enforced.
  check("rejects missing admin token", (await fetch(`${BASE}/api/bus/channels`)).status === 401);

  // Create a channel.
  const chRes = await adminFetch("/channels", { method: "POST", body: JSON.stringify({ name: "Ops Room" }) });
  const channel = (await chRes.json()) as any;
  check("channel created", chRes.status === 201 && typeof channel.id === "string");

  // Mint an agent token.
  const tkRes = await adminFetch("/tokens", {
    method: "POST",
    body: JSON.stringify({ name: "helper", channels: [channel.id], capabilities: ["receive", "send"], ttlHours: 1 }),
  });
  const token = (await tkRes.json()) as any;
  check("token minted with wtk_ key", tkRes.status === 201 && token.key.startsWith("wtk_"));

  // Bad token is rejected on the WS.
  const badWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws/bus/${channel.id}`, ["wtk.wtk_not_a_real_token"]);
  const badClose = await new Promise<number>((resolve) => badWs.on("close", (c) => resolve(c)));
  check("invalid token rejected on WS", badClose === 4001);

  // Agent connects with the real token.
  const agent = new WebSocket(`ws://127.0.0.1:${PORT}/ws/bus/${channel.id}`, [`wtk.${token.key}`]);
  const agentR = reader(agent);
  const joined = await agentR.next("joined");
  check("agent receives joined frame", joined.handle === "helper" && joined.channelId === channel.id);
  const policy = await agentR.next("policy");
  check("agent receives policy frame", Array.isArray(policy.rules) && policy.rules.length > 0);
  const history = await agentR.next("history");
  check("agent receives history frame", history.count === 0);

  // Dashboard (admin) connection observes.
  const dash = new WebSocket(`ws://127.0.0.1:${PORT}/ws/bus/${channel.id}`, [`wtk.${ADMIN}`]);
  const dashR = reader(dash);
  await dashR.next("joined");
  await dashR.next("history");

  // Agent sends a message; dashboard should receive it.
  const recv = dashR.next("message");
  agent.send(JSON.stringify({ type: "message", body: { text: "hello bus" } }));
  const msg = await recv;
  check("message fans out to other connection", msg.from === "helper" && (msg.body as any).text === "hello bus");
  check("server assigned a seq", typeof msg.seq === "number" && msg.seq >= 1);

  // Secret blocking.
  const secretEcho = agentR.next("error");
  agent.send(JSON.stringify({ type: "message", body: { text: "key AKIAIOSFODNN7EXAMPLE" } }));
  const err = await secretEcho;
  check("high-confidence secret is blocked", err.code === "secret_blocked");

  // Revocation drops the live socket.
  const closed = new Promise<number>((resolve) => agent.on("close", (c) => resolve(c)));
  await adminFetch(`/tokens/${token.id}`, { method: "DELETE" });
  const closeCode = await Promise.race([closed, sleep(3000).then(() => -1)]);
  check("revoking token closes the live socket", closeCode === 4003);

  agent.close(); dash.close();
  await sleep(100);
  console.log(failures === 0 ? "\nAll smoke checks passed ✅" : `\n${failures} check(s) failed ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
