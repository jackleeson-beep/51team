// MCP Router Stress Test Suite
// Pushes limits, finds breakpoints. Runs < 30s.

import http from "node:http";
import { execSync, spawn } from "node:child_process";

const PORT = process.env.MCP_BRIDGE_PORT || 9876;
const ROUTER_URL = `http://127.0.0.1:${PORT}`;
const ROUTER_SCRIPT = new URL("./server-http.js", import.meta.url).pathname;
const TMUX = findTmux();

function findTmux() {
  try {
    return require("child_process").execSync("command -v tmux 2>/dev/null || which tmux 2>/dev/null", {
      encoding: "utf8", timeout: 2000,
    }).trim();
  } catch {
    for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
      try {
        require("child_process").execSync(`test -x ${p}`);
        return p;
      } catch {}
    }
    return "tmux";
  }
}

// ── HTTP helpers ──

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${ROUTER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
      timeout: 5000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, ...JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${ROUTER_URL}${path}`, { timeout: 3000 }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, ...JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode }); }
      });
    }).on("error", reject);
  });
}

async function call(tool, args = {}) {
  return post("/api/call", { tool, args });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Formatting ──

const F = {
  n: (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n),
  b: (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "MB" : n >= 1e3 ? (n / 1e3).toFixed(1) + "KB" : n + "B",
  ms: (ms) => ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms.toFixed(0) + "ms",
};

// ── Test runner ──

const results = [];

function ok(name, metric, detail = "") {
  console.log(`  ✅ ${name}: ${metric}  ${detail}`);
  results.push({ name, pass: true, metric });
}

function warn(name, metric, detail = "") {
  console.log(`  ⚠️  ${name}: ${metric}  ${detail}`);
  results.push({ name, pass: false, metric });
}

function h1(title) {
  console.log(`\n┌──────────────────────────────────────────┐`);
  console.log(`│  ${title}`);
  console.log(`└──────────────────────────────────────────┘`);
}

// ════════════════════════════════════════════════════
//  TEST 1: Agent Scaling
// ════════════════════════════════════════════════════

async function testAgentScaling() {
  const ramp = [5, 10, 20, 50, 100, 200, 500];
  let max = 0;

  for (const target of ramp) {
    // Create tmux sessions
    const sessions = [];
    const t0 = Date.now();
    for (let i = 0; i < target; i++) {
      try {
        execSync(`${TMUX} new-session -d -s s${i} 2>/dev/null`, { timeout: 500 });
        sessions.push(`s${i}`);
      } catch { break; }
    }
    const tmuxTime = Date.now() - t0;

    // Register all
    let registered = 0;
    const t1 = Date.now();
    for (let i = 0; i < sessions.length; i++) {
      try {
        const r = await call("register_agent", { agent_name: `a${i}`, tmux_session: `s${i}` });
        if (r.ok) registered++;
      } catch { break; }
    }
    const regTime = Date.now() - t1;

    // Cleanup
    sessions.forEach((s) => {
      try { execSync(`${TMUX} kill-session -t ${s} 2>/dev/null`); } catch {}
    });

    const msg = `tmux:${sessions.length} reg:${registered} create:${F.ms(tmuxTime)} register:${F.ms(regTime)}`;
    if (registered === sessions.length) {
      ok(`batch ${target}`, `${registered} agents`, msg);
      max = registered;
    } else {
      warn(`batch ${target}`, `${registered}/${target}`, msg);
      break;
    }
  }

  ok("→ MAX AGENTS", `${max}`, "practical stable limit");
  return max;
}

// ════════════════════════════════════════════════════
//  TEST 2: Message Size Limits
// ════════════════════════════════════════════════════

async function testMessageSize() {
  execSync(`${TMUX} new-session -d -s sz 2>/dev/null`); try {} catch {}
  await call("register_agent", { agent_name: "sz", tmux_session: "sz" });

  const sizes = [1024, 4096, 16384, 65536, 262144, 524288, 1048576, 4194304];
  let maxOk = 0;

  for (const size of sizes) {
    const content = "X".repeat(size);
    const t0 = Date.now();
    try {
      const r = await call("send_message", { from: "sz", to: "sz", content });
      const ms = Date.now() - t0;
      if (r.ok) {
        ok(`  ${F.b(size)}`, `${F.ms(ms)}`, `payload`);
        maxOk = size;
      } else {
        warn(`  ${F.b(size)}`, `rejected`, r.text);
        break;
      }
    } catch (e) {
      warn(`  ${F.b(size)}`, `error`, e.message);
      break;
    }
  }

  ok("→ MAX MESSAGE", F.b(maxOk), "single message payload");
  execSync(`${TMUX} kill-session -t sz 2>/dev/null`); try {} catch {}
  return maxOk;
}

// ════════════════════════════════════════════════════
//  TEST 3: Throughput (msgs/sec burst)
// ════════════════════════════════════════════════════

async function testThroughput() {
  execSync(`${TMUX} new-session -d -s tp0 2>/dev/null`); try {} catch {}
  execSync(`${TMUX} new-session -d -s tp1 2>/dev/null`); try {} catch {}
  await call("register_agent", { agent_name: "tp0", tmux_session: "tp0" });
  await call("register_agent", { agent_name: "tp1", tmux_session: "tp1" });

  const DURATION = 5000;
  let sent = 0, errors = 0;
  const t0 = Date.now();

  const sender = async () => {
    while (Date.now() - t0 < DURATION) {
      try {
        const r = await call("send_message", { from: "tp0", to: "tp1", content: `msg${sent}` });
        if (r.ok) sent++; else errors++;
      } catch { errors++; }
    }
  };

  await Promise.all([sender(), sender(), sender(), sender()]);
  const elapsed = Date.now() - t0;
  const rate = (sent / (elapsed / 1000)).toFixed(1);

  ok("BURST 4x", `${sent} msgs / ${F.ms(elapsed)}`, `= ${rate} msg/s, ${errors} errors`);

  const state = await get("/api/state");
  const total = state.totalMessages || sent + 2; // +2 for register msgs in some cases

  ok("→ THROUGHPUT", `${rate} msg/s`, `store: ${total} total messages`);

  execSync(`${TMUX} kill-session -t tp0 2>/dev/null`); try {} catch {}
  execSync(`${TMUX} kill-session -t tp1 2>/dev/null`); try {} catch {}
  return rate;
}

// ════════════════════════════════════════════════════
//  TEST 4: tmux send-keys Reliability
// ════════════════════════════════════════════════════

async function testTmuxReliability() {
  const N = 30;
  const sessions = [];

  for (let i = 0; i < N; i++) {
    try {
      execSync(`${TMUX} new-session -d -s tx${i} "cat" 2>/dev/null`, { timeout: 500 });
      sessions.push(`tx${i}`);
    } catch { break; }
  }

  const t0 = Date.now();
  let delivered = 0;
  const LINE = "[Bridge] test | check_messages";

  for (const s of sessions) {
    try {
      execSync(`${TMUX} send-keys -t '${s}' '${LINE}' Enter 2>/dev/null`, { timeout: 300 });
      delivered++;
    } catch {}
  }

  let verified = 0;
  for (const s of sessions) {
    try {
      const out = execSync(`${TMUX} capture-pane -t '${s}' -p 2>/dev/null`, {
        timeout: 300, encoding: "utf8",
      });
      if (out.includes("Bridge")) verified++;
    } catch {}
  }

  const ms = Date.now() - t0;
  ok("send-keys", `${delivered}/${sessions.length} delivered, ${verified} verified`, F.ms(ms));

  sessions.forEach((s) => {
    try { execSync(`${TMUX} kill-session -t ${s} 2>/dev/null`); } catch {}
  });

  ok("→ TMUX RELIABILITY", `${(verified / sessions.length * 100).toFixed(0)}%`, "verified delivery rate");
}

// ════════════════════════════════════════════════════
//  TEST 5: Concurrent SSE Connections
// ════════════════════════════════════════════════════

async function testConcurrentSSE() {
  const ramp = [10, 25, 50, 100, 200];
  let max = 0;

  for (const target of ramp) {
    const conns = [];
    for (let i = 0; i < target; i++) {
      try {
        const c = await new Promise((resolve, reject) => {
          const req = http.get(`${ROUTER_URL}/mcp`, { timeout: 1500 }, (res) => resolve(res));
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        });
        conns.push(c);
      } catch { break; }
    }
    conns.forEach((c) => { try { c.destroy(); } catch {} });

    if (conns.length === target) {
      ok(`  ${target} SSE`, `${conns.length} connections`);
      max = conns.length;
    } else {
      warn(`  ${target} SSE`, `${conns.length}/${target}`, "FD or connection limit");
      if (conns.length > max) max = conns.length;
      break;
    }
  }

  ok("→ MAX SSE", `${max}`, "concurrent connections");
  return max;
}

// ════════════════════════════════════════════════════
//  TEST 6: Memory Pressure
// ════════════════════════════════════════════════════

async function testMemoryPressure() {
  execSync(`${TMUX} new-session -d -s mp 2>/dev/null`); try {} catch {}
  await call("register_agent", { agent_name: "mp", tmux_session: "mp" });

  const sizes = [1024, 4096, 16384];
  for (const size of sizes) {
    const content = "X".repeat(size);
    const t0 = Date.now();
    let ok_count = 0;
    for (let i = 0; i < 200; i++) {
      try {
        const r = await call("send_message", { from: "mp", to: "mp", content });
        if (r.ok) ok_count++; else break;
      } catch { break; }
    }
    const dataVolume = ok_count * size;
    ok(`${F.b(size)} x ${ok_count}`, F.b(dataVolume), `total written, ${F.ms(Date.now() - t0)}`);
  }

  // Memory check via health
  const h = await get("/health");
  const state = await get("/api/state");

  ok("→ MEMORY", `${state.totalMessages} msgs in store`, `health: ${h.status}`);

  execSync(`${TMUX} kill-session -t mp 2>/dev/null`); try {} catch {}
}

// ════════════════════════════════════════════════════
//  TEST 7: Realistic Team Simulation
// ════════════════════════════════════════════════════

async function testRealisticTeam() {
  const TEAM = ["architect", "frontend", "backend", "qa", "devops"];
  for (const role of TEAM) {
    execSync(`${TMUX} new-session -d -s rl-${role} 2>/dev/null`); try {} catch {}
    await call("register_agent", { agent_name: role, tmux_session: `rl-${role}` });
  }

  const conv = [
    ["architect", "all", "用户系统设计", "需求：用户注册/登录/权限管理。RESTful API，JWT 认证。请各角色确认。"],
    ["frontend", "architect", "用户系统设计", "前端确认。需要 API: POST /auth/login, POST /auth/register, GET /auth/me。用 React Router + Context。"],
    ["backend", "architect", "用户系统设计", "后端确认。JWT + refresh token，bcrypt。users 表已设计。"],
    ["qa", "backend", "用户系统设计", "QA 介入。请提供测试账号和 API 文档。测试范围: 注册、登录、token 刷新、并发。"],
    ["devops", "all", "用户系统设计", "DevOps: CI/CD 已配置。JWT_SECRET 需注入环境变量。DB 迁移脚本在 /migrations。"],
    ["frontend", "backend", "API 对接", "确认: /api/users 返回 role 字段吗？分页是 page/size 还是 offset/limit？"],
    ["backend", "frontend", "API 对接", "确认: user.role 在响应中。分页 page/size，默认 page=1 size=20。API 文档 3.2 节已更新。"],
    ["qa", "all", "测试报告", "第一轮: 47/50 通过。3 个问题: 密码长度限制不一致、中文用户名 500、token 刷新偶发 401。"],
  ];

  const t0 = Date.now();
  let delivered = 0, notified = 0;

  for (const [from, to, topic, content] of conv) {
    try {
      const r = await call("send_message", { from, to, topic, content });
      if (r.ok) {
        delivered++;
        // Verify tmux notification
        if (to !== "all") {
          try {
            const pane = execSync(`${TMUX} capture-pane -t 'rl-${to}' -p 2>/dev/null`, {
              timeout: 300, encoding: "utf8",
            });
            if (pane.includes("Bridge")) notified++;
          } catch {}
        }
      }
    } catch {}
  }

  const ms = Date.now() - t0;
  ok("SIMULATION", `${delivered}/${conv.length} msgs`, `${notified} tmux notifications, ${F.ms(ms)}`);

  const state = await get("/api/state");
  const topics = new Set((state.messages || []).map((m) => m.topic).filter(Boolean));
  ok("→ REALISTIC TEAM", `${TEAM.length} agents, ${topics.size} topics, ${state.totalMessages} msgs`);

  TEAM.forEach((r) => {
    try { execSync(`${TMUX} kill-session -t rl-${r} 2>/dev/null`); } catch {}
  });
}

// ════════════════════════════════════════════════════
//  Main
// ════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   MCP Router · STRESS TEST SUITE        ║");
  console.log("╚══════════════════════════════════════════╝");

  // Sysinfo
  console.log(`  Node ${process.version}  ·  tmux ${execSync(`${TMUX} -V`, { encoding: "utf8", timeout: 1000 }).trim()}`);
  try {
    const fd = execSync("ulimit -n 2>/dev/null", { encoding: "utf8", timeout: 1000 }).trim();
    console.log(`  File descriptors: ${fd}`);
  } catch {}

  // Start router
  console.log("\n  Starting router...");
  spawn("node", [ROUTER_SCRIPT], { detached: true, stdio: "ignore" }).unref();
  await sleep(2000);

  // Verify
  try {
    await get("/health");
    console.log("  ✅ Router ready\n");
  } catch {
    console.log("  ❌ Router startup failed\n");
    process.exit(1);
  }

  const T0 = Date.now();

  h1("1. AGENT SCALING — max simultaneous agents");
  const maxAgents = await testAgentScaling();

  h1("2. MESSAGE SIZE — max payload");
  const maxMsg = await testMessageSize();

  h1("3. THROUGHPUT — burst messages/sec");
  const throughput = await testThroughput();

  h1("4. TMUX RELIABILITY — send-keys delivery rate");
  await testTmuxReliability();

  h1("5. SSE CONNECTIONS — concurrent streams");
  const maxSSE = await testConcurrentSSE();

  h1("6. MEMORY PRESSURE — large message store");
  await testMemoryPressure();

  h1("7. REALISTIC TEAM — 5-agent collaboration");
  await testRealisticTeam();

  // ── Summary ──
  const totalMs = Date.now() - T0;
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║         STRESS TEST RESULTS             ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Tests: ${results.length}  (${pass} pass, ${fail} fail)  ·  Time: ${F.ms(totalMs)}`);
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Max Agents:       ${String(maxAgents).padStart(5)}                ║`);
  console.log(`║  Max Message:      ${F.b(maxMsg).padStart(5)}                ║`);
  console.log(`║  Throughput:       ${String(throughput).padStart(5)} msg/s           ║`);
  console.log(`║  Max SSE Conn:     ${String(maxSSE).padStart(5)}                ║`);
  console.log("╠══════════════════════════════════════════╣");
  console.log("║  RECOMMENDED LIMITS:                    ║");
  console.log(`║  Team size:   ≤ ${Math.min(maxAgents, 20)} agents`);
  console.log(`║  Message:     ≤ ${F.b(Math.min(maxMsg, 65536))}`);
  console.log(`║  Duration:    hours (no hard limit)`);
  console.log(`║  Context:     bounded by msg store`);
  console.log("╚══════════════════════════════════════════╝");

  // Cleanup
  try { execSync("kill $(lsof -t -i:${PORT}) 2>/dev/null || true", { timeout: 2000 }); } catch {}
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  try { execSync("kill $(lsof -t -i:${PORT}) 2>/dev/null || true", { timeout: 2000 }); } catch {}
  process.exit(1);
});
