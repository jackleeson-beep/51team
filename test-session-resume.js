// Session Resume Test — 模拟 Claude Code MCP 客户端连接到 51team Router
// 测试：连接 → 断开(wait 10s) → 用旧的 sessionId 重建连接 → 继续工具调用
// 如果 resume 失效，POST 会返回 404 "Session not found"
import http from "node:http";

const PORT = process.env.MCP_BRIDGE_PORT || 9876;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name, msg = "") {
  console.log(`  ✅ ${name}  ${msg}`);
  passed++;
}
function fail(name, msg) {
  console.log(`  ❌ ${name}: ${msg}`);
  failed++;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── SSE session ──
function connectSSE(sessionId) {
  const url = sessionId
    ? `${BASE}/mcp?sessionId=${sessionId}`
    : `${BASE}/mcp`;
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      // Expect 200 + event-stream content type
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        // Wait until we receive the endpoint event
        if (buf.includes("endpoint") && !res._resolved) {
          res._resolved = true;
          const sid =
            res.headers["mcp-session-id"] ||
            (buf.match(/sessionId=([^\s\"]+)/) || [])[1];
          resolve({ res, req, sessionId: sid });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// ── POST JSON-RPC via SSE session ──
async function postMcp(sessionId, body) {
  const url = `${BASE}/mcp?sessionId=${sessionId}`;
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Accept: "application/json, text/event-stream",
        },
        timeout: 5000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: buf });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(data);
    req.end();
  });
}

// ── Wait for SSE event message on an active stream ──
function waitForMessage(res, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout waiting for SSE message"));
    }, timeout);
    res.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("event: message")) {
        clearTimeout(timer);
        const match = text.match(/data: (.+)/);
        if (match) {
          try {
            resolve(JSON.parse(match[1]));
          } catch {
            resolve(match[1]);
          }
        } else {
          resolve(text);
        }
      }
    });
  });
}

// ═══════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════

async function main() {
  console.log("═══ Session Resume Test ═══");
  console.log(`  Router: ${BASE}/health\n`);

  // Check health
  try {
    const h = await new Promise((resolve, reject) => {
      http.get(`${BASE}/health`, { timeout: 3000 }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve(JSON.parse(d)));
      }).on("error", reject);
    });
    if (h.status !== "ok") {
      console.log("  ❌ Router not available. Start with: 51team up\n");
      process.exit(1);
    }
  } catch (e) {
    console.log(`  ❌ Router not available: ${e.message}\n`);
    process.exit(1);
  }

  // Clear state before test
  await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/clear`, { method: "POST" }, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => resolve());
    });
    req.on("error", reject);
    req.end();
  });
  await sleep(200);

  // ── 1. New session ──
  console.log("── Phase 1: New session ──");
  let sse;
  try {
    sse = await connectSSE();
    ok("SSE Connected", `session=${sse.sessionId}`);
  } catch (e) {
    fail("SSE Connected", e.message);
    process.exit(1);
  }

  // ── 2. Initialize ──
  console.log("\n── Phase 2: Initialize ──");
  const initResp = await postMcp(sse.sessionId, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-session-resume", version: "1.0" },
    },
  });
  if (initResp.status === 202) ok("Initialize POST", "accepted");
  else fail("Initialize POST", `status=${initResp.status}`);

  // Wait for SSE message response
  await sleep(500);

  // ── 3. tools/list ──
  console.log("\n── Phase 3: tools/list ──");
  const listResp = await postMcp(sse.sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  if (listResp.status === 202) ok("tools/list POST", "accepted");
  else fail("tools/list POST", `status=${listResp.status}`);

  await sleep(500);

  // ── 4. register_agent ──
  console.log("\n── Phase 4: register_agent ──");
  const regResp = await postMcp(sse.sessionId, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "register_agent", arguments: { agent_name: "test-resume-agent", tmux_session: "test-resume" } },
  });
  if (regResp.status === 202) ok("register_agent POST", "accepted");
  else fail("register_agent POST", `status=${regResp.status}`);

  await sleep(500);

  // ── 5. Disconnect SSE ──
  console.log("\n── Phase 5: Disconnect SSE (simulate network blip) ──");
  sse.req.destroy();
  ok("SSE Disconnected", "client side closed");

  // Wait 5 seconds (within the 30s grace period)
  await sleep(8000);

  // ── 6. tools/call while disconnected (should return 200 + JSON body) ──
  console.log("\n── Phase 6: tools/call while SSE disconnected (< 30s grace) ──");
  const disconnectedResp = await postMcp(sse.sessionId, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "heartbeat", arguments: { agent_name: "test-resume-agent" } },
  });
  if (disconnectedResp.status === 200) {
    const body = JSON.parse(disconnectedResp.body);
    (body.result?.content ? ok : fail)("Heartbeat while disconnected", body.result?.content ? "JSON-RPC in HTTP body" : disconnectedResp.body.slice(0, 80));
  } else {
    fail("Heartbeat while disconnected", `status=${disconnectedResp.status}`);
  }

  // ── 7. Reconnect with same sessionId ──
  console.log("\n── Phase 7: Resume session (same sessionId, within grace period) ──");
  let sse2;
  try {
    sse2 = await connectSSE(sse.sessionId);
    ok("SSE Resumed", `session=${sse2.sessionId}`);
  } catch (e) {
    fail("SSE Resumed", e.message);
  }

  // ── 8. After resume: call heartbeat (should still work) ──
  console.log("\n── Phase 8: heartbeat after resume ──");
  const hbResp = await postMcp(sse2.sessionId, {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "heartbeat", arguments: { agent_name: "test-resume-agent" } },
  });
  (hbResp.status === 202 ? ok : fail)("Heartbeat after resume", hbResp.status === 202 ? "accepted" : `status=${hbResp.status}`);

  await sleep(500);

  // ── 9. send_message after resume ──
  console.log("\n── Phase 9: send_message after resume ──");
  const msgResp = await postMcp(sse2.sessionId, {
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "send_message", arguments: { from: "test-resume-agent", to: "test-resume-agent", topic: "resume-test", content: "hello" } },
  });
  (msgResp.status === 202 ? ok : fail)("send_message after resume", msgResp.status === 202 ? "accepted" : `status=${msgResp.status}`);

  await sleep(500);

  // ── 10. Verify message ──
  console.log("\n── Phase 10: Verify state ──");
  try {
    const state = await new Promise((resolve, reject) => {
      http.get(`${BASE}/api/state`, { timeout: 3000 }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve(JSON.parse(d)));
      }).on("error", reject);
    });
    const msgs = state.messages.filter((m) => m.topic === "resume-test");
    (msgs.length === 1 ? ok : fail)("Message check", msgs.length === 1 ? "persisted" : `expected 1, got ${msgs.length}`);
  } catch (e) {
    fail("Message check", e.message);
  }

  // ── 11. Expiration ──
  console.log("\n── Phase 11: Disconnect + wait 31s (exceed 30s grace) ──");
  sse2.req.destroy();
  ok("SSE destroyed", "waiting 31s...");
  await sleep(31000);

  // ── 12. Expired session ──
  console.log("\n── Phase 12: Expired session ──");
  const deadResp = await postMcp(sse2.sessionId, {
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "list_agents", arguments: {} },
  });
  if (deadResp.status === 404) {
    ok("Expired session", "rejected with 404");
  } else {
    const body = deadResp.body ? JSON.parse(deadResp.body) : {};
    (body.error?.code === -32001 ? ok : fail)("Expired session", `status=${deadResp.status} code=${body.error?.code}`);
  }

  // ── Cleanup ──
  console.log("\n── Cleanup ──");
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(`${BASE}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve(JSON.parse(d)));
      });
      req.on("error", reject);
      req.write(JSON.stringify({ tool: "unregister_agent", args: { agent_name: "test-resume-agent" } }));
      req.end();
    });
    ok("Cleanup done");
  } catch {}

  // ── Summary ──
  const total = passed + failed;
  console.log(`\n═══ Result: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ""} ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
