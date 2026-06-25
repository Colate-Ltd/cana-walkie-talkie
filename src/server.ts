#!/usr/bin/env node
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

// Brand banner — Cana by Colate (https://cana.build)
const c = {
  link: "\x1b[38;5;81m", // cyan link
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};
// "CANA.BUILD" wordmark with a top→bottom indigo→violet gradient.
const grad = ["\x1b[38;5;189m", "\x1b[38;5;147m", "\x1b[38;5;141m", "\x1b[38;5;135m", "\x1b[38;5;99m", "\x1b[38;5;99m"];
const art = [
  " ██████╗ █████╗ ███╗   ██╗ █████╗    ██████╗ ██╗   ██╗██╗██╗     ██████╗ ",
  "██╔════╝██╔══██╗████╗  ██║██╔══██╗   ██╔══██╗██║   ██║██║██║     ██╔══██╗",
  "██║     ███████║██╔██╗ ██║███████║   ██████╔╝██║   ██║██║██║     ██║  ██║",
  "██║     ██╔══██║██║╚██╗██║██╔══██║   ██╔══██╗██║   ██║██║██║     ██║  ██║",
  "╚██████╗██║  ██║██║ ╚████║██║  ██║██╗██████╔╝╚██████╔╝██║███████╗██████╔╝",
  " ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝╚═════╝ ╚═════╝ ╚═╝╚══════╝╚═════╝ ",
];
const banner = [
  "",
  ...art.map((line, i) => `  ${grad[i]}${c.bold}${line}${c.reset}`),
  "",
  `  ${c.bold}Walkie-Talkie${c.reset} ${c.dim}· a shared workspace for teams and AI agents${c.reset}`,
  `  ${c.link}${c.bold}https://cana.build${c.reset}   ${c.dim}— by Colate${c.reset}`,
  "",
].join("\n");

server.listen(config.port, config.host, () => {
  console.log(banner);
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
