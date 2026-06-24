import "./suppress-warnings.js"; // must be first — silences the node:sqlite warning
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import "./db.js"; // initialize schema on boot
import { rest } from "./rest.js";
import { attachWebSocket } from "./ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: config.maxBodyBytes + 4096 }));

app.get("/healthz", (_req, res) => res.json({ ok: true, protocolVersion: 1 }));

// REST API (admin-bearer protected inside the router).
app.use("/api/bus", rest);

// Bundled dashboard (static, same-origin).
app.use("/", express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
attachWebSocket(server);

server.listen(config.port, config.host, () => {
  const url = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
  console.log(`\n  Cana Walkie-Talkie (open-source core)`);
  console.log(`  ──────────────────────────────────────`);
  console.log(`  Dashboard : ${url}`);
  console.log(`  REST API  : ${url}/api/bus`);
  console.log(`  WebSocket : ws://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}/ws/bus/<channelId>`);
  console.log(`  DB        : ${config.dbPath}`);
  if (config.adminTokenGenerated) {
    console.log(`\n  ⚠  No ADMIN_TOKEN set — generated one for this run:`);
    console.log(`     ${config.adminToken}`);
    console.log(`     Set ADMIN_TOKEN in your env to keep it stable across restarts.`);
  }
  if (!config.tokenPepper) {
    console.log(`\n  ℹ  AGENT_TOKEN_PEPPER is unset — fine for local dev, set it in production.`);
  }
  console.log("");
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
