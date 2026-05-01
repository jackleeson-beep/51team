// 51team — multi-agent collaboration over MCP + tmux.
// Architecture: one router, N agents connect via SSE, state in memory.
// Includes a web dashboard at / to view agent conversations.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";

// Logging: write to file + stderr
const LOG_DIR = join(homedir(), ".claude", "51team");
const LOG_FILE = process.env.LOG_FILE || join(LOG_DIR, "router.log");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const logStream = createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(line + "\n");
  logStream.write(line + "\n");
}

import {
  getAgents,
  registerAgent,
  unregisterAgent,
  heartbeat,
  clearAll,
  getStats,
  sendMessage,
  getUnread,
  markAllRead,
  getMessages,
} from "./store-memory.js";

import { sessionExists, notifyAgent } from "./tmux.js";

const PORT = process.env.MCP_BRIDGE_PORT || 9876;

// ═══════════════════════════════════════════
//  Tool handlers (shared by MCP + /api/call)
// ═══════════════════════════════════════════

const handlers = {
  async register_agent({ agent_name, tmux_session }) {
    registerAgent(agent_name, tmux_session);
    return { ok: true, text: `Agent "${agent_name}" 已注册。session: ${tmux_session}` };
  },

  async unregister_agent({ agent_name }) {
    unregisterAgent(agent_name);
    return { ok: true, text: `Agent "${agent_name}" 已注销` };
  },

  async heartbeat({ agent_name }) {
    if (heartbeat(agent_name)) {
      return { ok: true, text: `Agent "${agent_name}" 心跳已更新` };
    }
    return { ok: false, text: `Agent "${agent_name}" 未注册，请先 register_agent` };
  },

  async clear_all() {
    clearAll();
    return { ok: true, text: "所有 Agent 和消息已清除" };
  },

  async send_message({ from, to, topic, content }) {
    const agents = getAgents();
    const agentNames = Object.keys(agents);
    if (agentNames.length === 0) return { ok: false, text: "没有已注册的 Agent" };

    const results = [];
    let notifyOk = 0;
    let notifyFail = 0;
    if (to === "all") {
      const targets = agentNames.filter((n) => n !== from);
      if (targets.length === 0) return { ok: false, text: "没有其他 Agent 可广播" };
      for (const targetName of targets) {
        sendMessage(from, targetName, content, topic);
        const target = agents[targetName];
        if (target) {
          const ok = notifyAgent(target.tmuxSession, from, topic, content);
          if (ok) notifyOk++; else notifyFail++;
        }
        results.push(targetName);
      }
    } else {
      if (!agents[to]) return { ok: false, text: `Agent "${to}" 未注册。已注册: ${agentNames.join(", ")}` };
      sendMessage(from, to, content, topic);
      const ok = notifyAgent(agents[to].tmuxSession, from, topic, content);
      if (ok) notifyOk++; else notifyFail++;
      results.push(to);
    }
    const statusParts = [`已送达: ${results.join(", ")}`];
    if (notifyFail > 0) statusParts.push(`(tmux 通知: ${notifyOk} ✓, ${notifyFail} ✗)`);
    return { ok: true, text: statusParts.join(" "), detail: results };
  },

  async check_messages({ agent_name }) {
    const unread = getUnread(agent_name);
    if (unread.length === 0) return { ok: true, text: "没有未读消息", count: 0 };
    const summary = unread.map((m) => `[${m.id}] ${m.from}: ${m.content.slice(0, 80)}`);
    return { ok: true, text: `${unread.length} 条未读`, count: unread.length, summary };
  },

  async read_messages({ agent_name }) {
    const unread = getUnread(agent_name);
    if (unread.length === 0) return { ok: true, text: "没有未读消息", count: 0 };
    const msgs = unread.map((m) => ({ id: m.id, from: m.from, topic: m.topic, content: m.content, time: m.createdAt }));
    markAllRead(agent_name);
    return { ok: true, text: `已读 ${unread.length} 条`, count: unread.length, messages: msgs };
  },

  async list_agents() {
    const agents = getAgents();
    const names = Object.keys(agents);
    const list = names.map((n) => ({ name: n, session: agents[n].tmuxSession, online: sessionExists(agents[n].tmuxSession) }));
    const text = names.length === 0 ? "没有已注册的 Agent" : `${names.length} Agent: ` + names.join(", ");
    return { ok: true, text, count: names.length, agents: list };
  },
};

// ═══════════════════════════════════════════
//  Tool definitions (for tools/list response)
// ═══════════════════════════════════════════

const toolDefs = [
  { name: "register_agent", description: "注册当前 Agent 到通讯路由。绑定自己所在的 tmux session。", inputSchema: { type: "object", properties: { agent_name: { type: "string" }, tmux_session: { type: "string" } }, required: ["agent_name", "tmux_session"] } },
  { name: "unregister_agent", description: "注销 Agent。", inputSchema: { type: "object", properties: { agent_name: { type: "string" } }, required: ["agent_name"] } },
  { name: "send_message", description: "向其他 Agent 发送消息。to='all' 广播。务必填写 from 标明身份。", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, topic: { type: "string" }, content: { type: "string" } }, required: ["from", "to", "content"] } },
  { name: "check_messages", description: "检查未读消息。", inputSchema: { type: "object", properties: { agent_name: { type: "string" } }, required: ["agent_name"] } },
  { name: "read_messages", description: "读取未读消息全文，自动标记已读。", inputSchema: { type: "object", properties: { agent_name: { type: "string" } }, required: ["agent_name"] } },
  { name: "list_agents", description: "列出所有已注册 Agent 及在线状态。", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "heartbeat", description: "发送心跳以维持在线状态。每 2 分钟调用一次，否则 5 分钟后自动注销。", inputSchema: { type: "object", properties: { agent_name: { type: "string" } }, required: ["agent_name"] } },
  { name: "clear_all", description: "清除所有 Agent 和消息（用于测试重置）。", inputSchema: { type: "object", properties: {}, required: [] } },
];

// Tool result → MCP content wrapper
function mcpContent(result) {
  const text = result.ok !== false
    ? `${result.ok ? "✅ " : ""}${result.text}`
    : `⚠️ ${result.text}`;
  const extra = result.summary ? "\n" + result.summary.join("\n") : "";
  return [{ type: "text", text: text + extra }];
}

// ═══════════════════════════════════════════
//  SSE session manager
// ═══════════════════════════════════════════

const sessions = new Map(); // sessionId → { res }

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Fix 1: 发送非 JSON 字符串的 SSE 事件（endpoint URL 不能加引号）
function sseSendRaw(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}

// ═══════════════════════════════════════════
//  JSON-RPC handler
// ═══════════════════════════════════════════

async function handleJsonRpc(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "51team", version: "2.0.0" }, capabilities: { tools: {} } } };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolDefs } };
    case "tools/call": {
      const { name, arguments: args } = params || {};
      if (!handlers[name]) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } };
      try {
        const result = await handlers[name](args || {});
        return { jsonrpc: "2.0", id, result: { content: mcpContent(result) } };
      } catch (e) {
        return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
      }
    }
    case "notifications/initialized":
      return null; // no response needed
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

const httpServer = http.createServer(async (req, res) => {
  const url = req.url || "/";

  // MCP endpoint (manual SSE + JSON-RPC, bypassing MCP SDK transport)
  if (url === "/mcp" || url.startsWith("/mcp?")) {
    if (req.method === "GET") {
      // SSE connection: establish long-lived event stream
      const sessionId = randomUUID();
      // Fix 2: 加 Mcp-Session-Id 响应头，兼容新版 Claude Code Streamable HTTP 客户端
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Mcp-Session-Id": sessionId,
      });
      // Fix 1: endpoint URL 用 sseSendRaw，不加 JSON 引号
      sseSendRaw(res, "endpoint", `/mcp?sessionId=${sessionId}`);
      sessions.set(sessionId, { res });
      log(`[mcp] SSE connected: ${sessionId}`);
      // Fix 3: 30 秒 keep-alive 防止 TCP idle timeout
      const keepAlive = setInterval(() => { res.write(": heartbeat\n\n"); }, 30000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sessions.delete(sessionId);
        log(`[mcp] SSE disconnected: ${sessionId}`);
      });
      return; // SSE stays open
    }

    if (req.method === "POST") {
      // JSON-RPC call: parse, execute, send response via SSE
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      let msg;
      try { msg = JSON.parse(body); } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        return;
      }
      // Fix 5: 同时检查 query param 和 Mcp-Session-Id header
      const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const sessionId = urlObj.searchParams.get("sessionId")
        || req.headers["mcp-session-id"];
      const session = sessions.get(sessionId);

      // Fix 4: session 不存在时返回错误，而不是静默丢弃
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: msg.id || null }));
        return;
      }
      const response = await handleJsonRpc(msg);
      if (response) {
        sseSend(session.res, "message", response);
      }
      // Fix 6: 响应已通过 SSE 推送，HTTP body 应为空 202
      res.writeHead(202, {});
      res.end();
      return;
    }

    // Other methods → 405
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  // API: direct tool call (for stress testing)
  if (url === "/api/call" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const { tool, args } = JSON.parse(Buffer.concat(chunks).toString());
      if (!handlers[tool]) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `unknown tool: ${tool}` }));
        return;
      }
      const result = await handlers[tool](args || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `Invalid request: ${e.message}` }));
    }
    return;
  }

  // API: clear state
  if (url === "/api/clear" && req.method === "POST") {
    clearAll();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, text: "All state cleared" }));
    return;
  }

  // API: full state
  if (url === "/api/state") {
    const agents = getAgents();
    const msgs = getMessages();
    const stats = getStats();
    const state = {
      agents: Object.entries(agents).map(([name, info]) => ({
        name,
        ...info,
        online: sessionExists(info.tmuxSession),
      })),
      messages: msgs.slice(-200), // last 200 messages
      totalMessages: msgs.length,
      uptime: process.uptime(),
      stats,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return;
  }

  // SSE: real-time event stream for dashboard
  if (url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("event: connected\ndata: {}\n\n");

    const tick = setInterval(() => {
      try {
        const stats = getStats();
        const agents = getAgents();
        const list = Object.entries(agents).map(([name, info]) => ({
          name,
          ...info,
          online: sessionExists(info.tmuxSession),
        }));
        res.write(`event: state\ndata: ${JSON.stringify({ agents: list, stats })}\n\n`);
      } catch {
        clearInterval(tick);
      }
    }, 2000);

    req.on("close", () => {
      clearInterval(tick);
    });
    return;
  }

  // API: health
  if (url === "/health") {
    const agents = getAgents();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      agents: Object.keys(agents).length,
      messages: getMessages().length,
    }));
    return;
  }

  // Web Dashboard
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_HTML);
    return;
  }

  // favicon, robots — silent 204
  if (url === "/favicon.ico" || url === "/robots.txt") {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

httpServer.listen(PORT, "127.0.0.1", () => {
  log(`Router started on port ${PORT}`);
  log(`MCP:   http://127.0.0.1:${PORT}/mcp`);
  log(`Web:   http://127.0.0.1:${PORT}/`);
  log(`Log:   ${LOG_FILE}`);
});

process.on("SIGINT", () => { log("Router shutting down"); httpServer.close(); process.exit(0); });
process.on("SIGTERM", () => { log("Router shutting down"); httpServer.close(); process.exit(0); });

// ═══════════════════════════════════════════
//  Web Dashboard — Terminal / Cyberpunk theme
// ═══════════════════════════════════════════

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>51team — Agent Mesh</title>
<style>
  :root {
    --bg: #060b11;
    --surface: #0c1520;
    --border: #1a2940;
    --text: #c8d6e5;
    --muted: #5a6e85;
    --cyan: #00e5ff;
    --green: #00e676;
    --red: #ff3d4f;
    --amber: #ffab00;
    --purple: #b388ff;
    --pink: #ff4081;
    --glow-cyan: 0 0 12px rgba(0,229,255,.25);
    --glow-green: 0 0 12px rgba(0,230,118,.25);
    --glow-purple: 0 0 12px rgba(179,136,255,.25);
    --glow-red: 0 0 12px rgba(255,61,79,.25);
    --glow-amber: 0 0 12px rgba(255,171,0,.25);
    --font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Scanline overlay */
  body::after {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.03) 2px, rgba(0,0,0,.03) 4px);
    pointer-events: none;
    z-index: 999;
  }

  /* Grid background */
  body::before {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background-image:
      linear-gradient(rgba(0,229,255,.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0,229,255,.03) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
  }

  /* ── Header ── */
  .header {
    position: sticky; top: 0; z-index: 100;
    background: rgba(12,21,32,.92);
    backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--border);
    padding: 0 28px;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 1px 20px rgba(0,0,0,.4);
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .logo {
    font-family: var(--font-mono);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 2px;
    color: var(--cyan);
    text-shadow: 0 0 20px rgba(0,229,255,.4);
    text-transform: uppercase;
  }
  .logo-dot {
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: var(--glow-green);
    animation: logoPulse 2s ease-in-out infinite;
  }
  @keyframes logoPulse {
    0%, 100% { box-shadow: 0 0 8px rgba(0,230,118,.4); }
    50% { box-shadow: 0 0 20px rgba(0,230,118,.8); }
  }
  .logo-sub {
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 1px;
    font-family: var(--font-mono);
  }

  /* Stats bar */
  .stats-bar {
    display: flex;
    gap: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .stat-item {
    padding: 8px 18px;
    text-align: center;
    border-right: 1px solid var(--border);
  }
  .stat-item:last-child { border-right: none; }
  .stat-val {
    font-family: var(--font-mono);
    font-size: 20px;
    font-weight: 700;
    color: var(--cyan);
    text-shadow: 0 0 8px rgba(0,229,255,.3);
  }
  .stat-lbl {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--muted);
    margin-top: 2px;
  }

  /* ── Main layout ── */
  .layout {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 20px;
    padding: 20px 28px;
    max-width: 1440px;
    margin: 0 auto;
    height: calc(100vh - 64px);
  }

  /* ── Cards ── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    transition: border-color .3s;
  }
  .card:hover { border-color: rgba(0,229,255,.3); }
  .card-header {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(0,0,0,.2);
  }
  .card-title {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--muted);
  }
  .card-badge {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 10px;
    background: rgba(0,229,255,.1);
    color: var(--cyan);
    border: 1px solid rgba(0,229,255,.2);
  }
  .card-body { padding: 14px 18px; }

  /* ── Sidebar ── */
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
  }

  /* Agent card */
  .agent-node {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 8px;
    background: rgba(0,0,0,.2);
    border: 1px solid transparent;
    margin-bottom: 8px;
    transition: all .25s;
    position: relative;
    overflow: hidden;
  }
  .agent-node:hover {
    border-color: rgba(0,229,255,.25);
    background: rgba(0,229,255,.04);
  }
  .agent-node::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 2px;
    border-radius: 0 2px 2px 0;
  }
  .agent-node.online::before { background: var(--green); box-shadow: var(--glow-green); }
  .agent-node.offline::before { background: var(--red); box-shadow: var(--glow-red); }
  .agent-avatar {
    width: 36px; height: 36px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .agent-avatar.c0 { background: rgba(0,229,255,.15); color: var(--cyan); }
  .agent-avatar.c1 { background: rgba(179,136,255,.15); color: var(--purple); }
  .agent-avatar.c2 { background: rgba(0,230,118,.15); color: var(--green); }
  .agent-avatar.c3 { background: rgba(255,171,0,.15); color: var(--amber); }
  .agent-avatar.c4 { background: rgba(255,64,129,.15); color: var(--pink); }
  .agent-info { flex: 1; min-width: 0; }
  .agent-name { font-weight: 600; font-size: 13px; }
  .agent-session {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-status {
    font-size: 9px;
    font-family: var(--font-mono);
    padding: 2px 8px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: .5px;
  }
  .agent-status.online { color: var(--green); background: rgba(0,230,118,.1); }
  .agent-status.offline { color: var(--red); background: rgba(255,61,79,.1); }

  /* Filter chips */
  .filter-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .chip {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 5px 12px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    transition: all .2s;
    letter-spacing: .5px;
  }
  .chip:hover { border-color: var(--cyan); color: var(--text); }
  .chip.active { background: rgba(0,229,255,.12); border-color: var(--cyan); color: var(--cyan); box-shadow: var(--glow-cyan); }

  /* Topic list */
  .topic-item {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 6px 10px;
    color: var(--muted);
    cursor: pointer;
    border-radius: 4px;
    transition: all .15s;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .topic-item:hover { color: var(--text); background: rgba(255,255,255,.03); }
  .topic-count { float: right; color: var(--cyan); font-size: 9px; }

  /* ── Main message area ── */
  .main-area {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
  }

  /* Message card */
  .msg {
    padding: 16px 18px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    animation: msgIn .25s ease;
    position: relative;
    transition: border-color .2s;
  }
  .msg:hover { border-color: rgba(255,255,255,.1); }
  .msg.unread { border-left: 2px solid var(--amber); box-shadow: var(--glow-amber); }
  @keyframes msgIn { from { opacity: 0; transform: translateY(6px); } }

  .msg-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .msg-route {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .msg-from-to {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 12px;
  }
  .msg-arrow {
    color: var(--muted);
    font-size: 10px;
  }
  .msg-tag {
    font-size: 9px;
    font-family: var(--font-mono);
    padding: 2px 8px;
    border-radius: 10px;
    letter-spacing: .5px;
  }
  .msg-tag.topic { background: rgba(179,136,255,.12); color: var(--purple); }
  .msg-tag.read { background: rgba(0,230,118,.1); color: var(--green); }
  .msg-tag.unread-tag { background: rgba(255,171,0,.12); color: var(--amber); }

  .msg-body {
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: #dde4ef;
  }
  .msg-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--muted);
  }
  .msg-id { color: rgba(255,255,255,.15); }

  /* ── Empty state ── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 80px 20px;
    color: var(--muted);
    text-align: center;
  }
  .empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: .4;
  }
  .empty-title {
    font-family: var(--font-mono);
    font-size: 13px;
    letter-spacing: 1px;
    margin-bottom: 6px;
  }
  .empty-desc { font-size: 11px; opacity: .6; }

  /* ── Connection lines canvas ── */
  #topoCanvas {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    z-index: 0;
  }

  /* ── Responsive ── */
  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; }
    .header { padding: 0 16px; }
    .layout { padding: 12px 16px; }
    .stats-bar { display: none; }
  }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-left">
    <span class="logo"><span class="logo-dot"></span> 51team</span>
    <span class="logo-sub">v2 · Agent Mesh</span>
  </div>
  <div class="stats-bar">
    <div class="stat-item">
      <div class="stat-val" id="statAgents">0</div>
      <div class="stat-lbl">Agents</div>
    </div>
    <div class="stat-item">
      <div class="stat-val" id="statOnline">0</div>
      <div class="stat-lbl">Online</div>
    </div>
    <div class="stat-item">
      <div class="stat-val" id="statMsgs">0</div>
      <div class="stat-lbl">Messages</div>
    </div>
    <div class="stat-item">
      <div class="stat-val" id="statUnread">0</div>
      <div class="stat-lbl">Unread</div>
    </div>
    <div class="stat-item">
      <div class="stat-val" id="statTopics">0</div>
      <div class="stat-lbl">Topics</div>
    </div>
    <div class="stat-item">
      <div class="stat-val" id="statUptime">0s</div>
      <div class="stat-lbl">Uptime</div>
    </div>
  </div>
</div>

<!-- Main Layout -->
<div class="layout" id="layout">
  <!-- Sidebar -->
  <div class="sidebar">
    <!-- Agents -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">◈ Agents</span>
        <span class="card-badge" id="agentCountBadge">0</span>
      </div>
      <div class="card-body" id="agentList" style="max-height:260px;overflow-y:auto;">
        <div class="empty-state" style="padding:30px">
          <div class="empty-icon">◇</div>
          <div class="empty-title">NO AGENTS</div>
          <div class="empty-desc">等待 Agent 注册...</div>
        </div>
      </div>
    </div>

    <!-- Filter -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">◈ Filter</span>
      </div>
      <div class="card-body">
        <div class="filter-row" id="filterRow">
          <button class="chip active" data-filter="all">ALL</button>
        </div>
      </div>
    </div>

    <!-- Topics -->
    <div class="card" style="flex:1;">
      <div class="card-header">
        <span class="card-title">◈ Topics</span>
        <span class="card-badge" id="topicBadge">0</span>
      </div>
      <div class="card-body" id="topicList" style="max-height:200px;overflow-y:auto;">
        <div class="empty-state" style="padding:20px">
          <div class="empty-desc">暂无讨论主题</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Message stream -->
  <div class="main-area" id="msgStream">
    <div class="empty-state">
      <div class="empty-icon">◈</div>
      <div class="empty-title">MESSAGE STREAM</div>
      <div class="empty-desc">Agent 之间的通讯将显示在这里</div>
    </div>
  </div>
</div>

<!-- Topology canvas -->
<canvas id="topoCanvas"></canvas>

<script>
const COLORS = ['var(--cyan)', 'var(--purple)', 'var(--green)', 'var(--amber)', 'var(--pink)'];
const AVATARS = ['c0', 'c1', 'c2', 'c3', 'c4'];

let state = { agents: [], messages: [], totalMessages: 0 };
let lastMsgCount = 0;
let currentFilter = 'all';

// ── SSE for real-time agent/state updates (no message body in SSE) ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    try {
      const data = JSON.parse(e.data);
      // Merge agent online status from SSE
      if (data.agents) {
        data.agents.forEach(a => {
          const existing = state.agents.find(sa => sa.name === a.name);
          if (existing) existing.online = a.online;
        });
        updateStats();
        updateAgents();
        updateFilters();
      }
    } catch {}
  });
  es.addEventListener('connected', () => {});
  es.onerror = () => {
    // SSE disconnected, fall back to polling
    setTimeout(connectSSE, 5000);
  };
  return es;
}

// ── Fetch full state (messages + everything) ──
async function refresh() {
  try {
    const res = await fetch('/api/state');
    state = await res.json();
    updateStats();
    updateAgents();
    updateFilters();
    updateTopics();
    if (state.totalMessages !== lastMsgCount) {
      lastMsgCount = state.totalMessages;
      renderMessages();
      drawTopology();
    }
  } catch(e) { /* router starting up */ }
}

// ── Stats ──
function updateStats() {
  const online = state.agents.filter(a => a.online).length;
  const unread = state.messages.filter(m => !m.read).length;
  const topics = new Set(state.messages.filter(m => m.topic && m.topic !== 'general').map(m => m.topic)).size;
  document.getElementById('statAgents').textContent = state.agents.length;
  document.getElementById('statOnline').textContent = online;
  document.getElementById('statMsgs').textContent = state.totalMessages;
  document.getElementById('statUnread').textContent = unread;
  document.getElementById('statTopics').textContent = topics;
  document.getElementById('agentCountBadge').textContent = state.agents.length;
  document.getElementById('topicBadge').textContent = topics;

  const uptime = Math.floor(state.uptime);
  const u = uptime > 3600 ? Math.floor(uptime/3600)+'h'+Math.floor(uptime/60)%60+'m'
          : uptime > 60 ? Math.floor(uptime/60)+'m'+uptime%60+'s'
          : uptime+'s';
  document.getElementById('statUptime').textContent = u;
}

// ── Agents ──
function updateAgents() {
  const el = document.getElementById('agentList');
  if (!state.agents.length) {
    el.innerHTML = '<div class="empty-state" style="padding:30px"><div class="empty-icon">◇</div><div class="empty-title">NO AGENTS</div><div class="empty-desc">等待 Agent 注册...</div></div>';
    return;
  }
  el.innerHTML = state.agents.map((a, i) =>
    '<div class="agent-node ' + (a.online ? 'online' : 'offline') + '">' +
    '<div class="agent-avatar ' + AVATARS[i % AVATARS.length] + '">' + a.name[0].toUpperCase() + '</div>' +
    '<div class="agent-info">' +
    '<div class="agent-name">' + he(a.name) + '</div>' +
    '<div class="agent-session">' + he(a.tmuxSession) + '</div>' +
    '</div>' +
    '<span class="agent-status ' + (a.online ? 'online' : 'offline') + '">' +
    (a.online ? 'LIVE' : 'GONE') + '</span>' +
    '</div>'
  ).join('');
}

// ── Filters ──
function updateFilters() {
  const row = document.getElementById('filterRow');
  let html = '<button class="chip' + (currentFilter === 'all' ? ' active' : '') + '" data-filter="all">ALL</button>';
  state.agents.forEach(a => {
    html += '<button class="chip' + (currentFilter === a.name ? ' active' : '') + '" data-filter="' + he(a.name) + '">' + he(a.name) + '</button>';
  });
  row.innerHTML = html;
  row.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      currentFilter = chip.dataset.filter;
      updateFilters();
      renderMessages();
    });
  });
}

// ── Topics ──
function updateTopics() {
  const el = document.getElementById('topicList');
  const topicMap = {};
  state.messages.forEach(m => {
    const t = m.topic || 'general';
    topicMap[t] = (topicMap[t] || 0) + 1;
  });
  const entries = Object.entries(topicMap);
  if (!entries.length) {
    el.innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-desc">暂无讨论主题</div></div>';
    return;
  }
  el.innerHTML = entries.map(([t, c]) =>
    '<div class="topic-item"><span class="topic-count">' + c + '</span>' + he(t) + '</div>'
  ).join('');
}

// ── Messages ──
function renderMessages() {
  const el = document.getElementById('msgStream');
  let msgs = currentFilter === 'all'
    ? state.messages
    : state.messages.filter(m => m.from === currentFilter || m.to === currentFilter);

  if (!msgs.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">◈</div><div class="empty-title">MESSAGE STREAM</div><div class="empty-desc">Agent 之间的通讯将显示在这里</div></div>';
    return;
  }

  // Newest first
  msgs = msgs.slice().reverse();

  el.innerHTML = msgs.map(m => {
    const isUnread = !m.read;
    return '<div class="msg' + (isUnread ? ' unread' : '') + '">' +
      '<div class="msg-top">' +
      '<div class="msg-route">' +
      '<span class="msg-from-to" style="color:' + agentColor(m.from) + '">' + he(m.from) + '</span>' +
      '<span class="msg-arrow">▸</span>' +
      '<span class="msg-from-to" style="color:' + agentColor(m.to) + '">' + he(m.to) + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:6px;">' +
      (m.topic && m.topic !== 'general' ? '<span class="msg-tag topic">' + he(m.topic) + '</span>' : '') +
      '<span class="msg-tag ' + (isUnread ? 'unread-tag' : 'read') + '">' + (isUnread ? 'UNREAD' : 'READ') + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="msg-body">' + he(m.content) + '</div>' +
      '<div class="msg-meta">' +
      '<span>' + m.createdAt + '</span>' +
      '<span class="msg-id">#' + m.id + '</span>' +
      '</div>' +
      '</div>';
  }).join('');

  // Scroll to top to show newest
  el.scrollTop = 0;
}

function agentColor(name) {
  const idx = state.agents.findIndex(a => a.name === name);
  return idx >= 0 ? ['#00e5ff','#b388ff','#00e676','#ffab00','#ff4081'][idx % 5] : 'var(--text)';
}

// ── Topology canvas ──
function drawTopology() {
  const canvas = document.getElementById('topoCanvas');
  const layout = document.getElementById('layout');
  canvas.width = layout.offsetWidth;
  canvas.height = layout.offsetHeight;
  canvas.style.left = layout.offsetLeft + 'px';
  canvas.style.top = layout.offsetTop + 'px';

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.agents.length < 2) return;

  // Get agent node positions
  const nodes = [];
  document.querySelectorAll('.agent-node').forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const layoutRect = layout.getBoundingClientRect();
    nodes.push({
      x: rect.left - layoutRect.left + rect.width,
      y: rect.top - layoutRect.top + rect.height / 2,
      color: ['#00e5ff','#b388ff','#00e676','#ffab00','#ff4081'][i % 5],
      online: state.agents[i]?.online
    });
  });

  // Draw connections between online agents
  // Show recent communication paths
  const recentMsgs = state.messages.slice(-20);
  const connections = new Set();
  recentMsgs.forEach(m => {
    connections.add(m.from + '→' + m.to);
  });

  connections.forEach(conn => {
    const [from, to] = conn.split('→');
    const fromNode = nodes[state.agents.findIndex(a => a.name === from)];
    const toNode = nodes[state.agents.findIndex(a => a.name === to)];
    if (!fromNode || !toNode) return;

    ctx.beginPath();
    ctx.moveTo(fromNode.x, fromNode.y);
    // Bezier curve
    const midX = (fromNode.x + toNode.x) / 2;
    const midY = (fromNode.y + toNode.y) / 2 + 20;
    ctx.quadraticCurveTo(midX + 30, midY - 10, toNode.x, toNode.y);
    ctx.strokeStyle = fromNode.color + '22';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Animated dot on the line
    const t = (Date.now() % 3000) / 3000;
    const dotX = (1-t)*(1-t)*fromNode.x + 2*(1-t)*t*midX + t*t*toNode.x;
    const dotY = (1-t)*(1-t)*fromNode.y + 2*(1-t)*t*midY + t*t*toNode.y;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 2, 0, Math.PI*2);
    ctx.fillStyle = fromNode.color + '88';
    ctx.fill();
  });
}

function he(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

connectSSE();
refresh();
setInterval(refresh, 5000);  // full state poll (messages) — SSE handles agent status
setInterval(drawTopology, 100);
</script>
</body>
</html>`;
