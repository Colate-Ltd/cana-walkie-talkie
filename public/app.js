/* Cana Walkie-Talkie dashboard — vanilla JS, no build step. */
const $ = (id) => document.getElementById(id);
let adminToken = localStorage.getItem("wt-admin-token") || "";
let activeChannel = null;
let ws = null;

const api = (path, opts = {}) =>
  fetch(`/api/bus${path}`, {
    ...opts,
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}`, ...(opts.headers || {}) },
  });

// ── Admin token ──────────────────────────────────────────────────────
$("adminToken").value = adminToken;
$("saveToken").onclick = () => {
  adminToken = $("adminToken").value.trim();
  localStorage.setItem("wt-admin-token", adminToken);
  loadChannels();
};

// ── Channels ─────────────────────────────────────────────────────────
async function loadChannels() {
  const res = await api("/channels");
  if (!res.ok) { renderChannels([]); return; }
  const { channels } = await res.json();
  renderChannels(channels);
}

function renderChannels(channels) {
  const ul = $("channelList");
  ul.innerHTML = "";
  for (const c of channels) {
    const li = document.createElement("li");
    if (activeChannel && c.id === activeChannel.id) li.className = "active";
    li.innerHTML = `<div class="cname">${esc(c.name)}</div>
      <div class="cmeta">${c.status} · ${c.liveConnections} live · ${c.messageCount} msgs</div>`;
    li.onclick = () => openChannel(c);
    ul.appendChild(li);
  }
}

$("newChannel").onclick = async () => {
  const name = prompt("Channel name?");
  if (!name) return;
  const res = await api("/channels", { method: "POST", body: JSON.stringify({ name }) });
  if (res.ok) loadChannels();
  else alert("Failed (check admin token).");
};

$("killChannel").onclick = async () => {
  if (!activeChannel || !confirm(`Close #${activeChannel.name}?`)) return;
  await api(`/channels/${activeChannel.id}/kill`, { method: "POST" });
  closeWs();
  activeChannel = null;
  $("viewerHead").classList.add("hidden");
  $("composer").classList.add("hidden");
  $("messages").innerHTML = `<div class="empty">Channel closed.</div>`;
  loadChannels();
};

// ── Open + live stream ───────────────────────────────────────────────
function openChannel(c) {
  activeChannel = c;
  loadChannels();
  $("viewerHead").classList.remove("hidden");
  $("composer").classList.remove("hidden");
  $("chName").textContent = "#" + c.name;
  $("chMeta").textContent = c.slug;
  $("messages").innerHTML = "";
  connectWs(c.id);
}

function connectWs(channelId) {
  closeWs();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/bus/${encodeURIComponent(channelId)}`, [`wtk.${adminToken}`]);
  ws.onmessage = (ev) => {
    const f = JSON.parse(ev.data);
    if (f.type === "history") f.messages.forEach(addMessage);
    else if (f.type === "message") addMessage(f);
    else if (f.type === "system") addSystem(f);
    else if (f.type === "error") addSystem({ body: { handle: "error: " + f.message } });
  };
  ws.onclose = () => {};
}
function closeWs() { if (ws) { ws.onclose = null; ws.close(); ws = null; } }

function addMessage(f) {
  const div = document.createElement("div");
  const mine = f.from === "dashboard";
  div.className = "msg" + (mine ? " me" : "");
  const text = typeof f.body === "object" && f.body && "text" in f.body ? f.body.text : JSON.stringify(f.body);
  const pills = [];
  if (f.to) pills.push(`→ ${esc(f.to)}`);
  if (f.private) pills.push("private");
  div.innerHTML = `<div class="from">${esc(f.from)}${pills.map((p) => `<span class="pill">${p}</span>`).join("")}</div>${esc(String(text))}`;
  const box = $("messages");
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function addSystem(f) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = (f.event ? f.event.replace("_", " ") + " — " : "") + (f.body?.handle || "");
  $("messages").appendChild(div);
}

// ── Composer ─────────────────────────────────────────────────────────
$("composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("composeText").value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const to = $("composeTo").value.trim().replace(/^@/, "") || null;
  ws.send(JSON.stringify({ type: "message", to, private: $("composePrivate").checked, body: { text } }));
  $("composeText").value = "";
};

// ── Mint token ───────────────────────────────────────────────────────
$("mintToken").onclick = () => { $("tkResult").classList.add("hidden"); $("tokenModal").classList.remove("hidden"); };
$("tkCancel").onclick = () => $("tokenModal").classList.add("hidden");
$("tkCreate").onclick = async () => {
  if (!activeChannel) return;
  const caps = [];
  if ($("capReceive").checked) caps.push("receive");
  if ($("capSend").checked) caps.push("send");
  const res = await api("/tokens", {
    method: "POST",
    body: JSON.stringify({ name: $("tkName").value.trim() || "agent", channels: [activeChannel.id], capabilities: caps, ttlHours: Number($("tkTtl").value) }),
  });
  if (!res.ok) { alert("Mint failed."); return; }
  const t = await res.json();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsBase = `${proto}://${location.host}`;
  $("tkKey").textContent = t.key;
  $("tkCmd").textContent = `/walkie-talkie ${wsBase} ${activeChannel.id} ${t.key} <YOUR ROLE + STOP CONDITION>`;
  $("tkResult").classList.remove("hidden");
  $("copyKey").onclick = () => navigator.clipboard.writeText(t.key);
  $("copyCmd").onclick = () => navigator.clipboard.writeText($("tkCmd").textContent);
};

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

if (adminToken) loadChannels();
setInterval(() => { if (adminToken) loadChannels(); }, 10000);
