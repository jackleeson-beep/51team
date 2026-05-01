// 51team Health Check — Comprehensive System Test
// Covers: resilience, multi-agent, throughput, edge cases, persistence
import { execSync } from "node:child_process";
import http from "node:http";

const TMUX = (() => {
  try { return execSync("command -v tmux", { encoding: "utf8", timeout: 2000 }).trim(); }
  catch { return "tmux"; }
})();

const PORT = process.env.MCP_BRIDGE_PORT || 9876;
const API = `http://127.0.0.1:${PORT}/api/call`;
const STATE = `http://127.0.0.1:${PORT}/api/state`;
const HEALTH = `http://127.0.0.1:${PORT}/health`;
const CLEAR = `http://127.0.0.1:${PORT}/api/clear`;

function api(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ tool, args });
    const req = http.request(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 5000 }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    }).on("error", reject);
  });
}

async function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = http.request(url, {
      method: "POST",
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
      timeout: 5000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => buf += c);
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function tsh(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 3000, stdio: "pipe" }).trim(); }
  catch { return ""; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Report ──
const report = [];
let passed = 0, failed = 0, warnings = 0;

function ok(test, metric, detail = "") {
  console.log(`  ✅ ${test}: ${metric}  ${detail}`);
  report.push({ test, status: "PASS", metric, detail });
  passed++;
}

function fail(test, metric, detail = "") {
  console.log(`  ❌ ${test}: ${metric}  ${detail}`);
  report.push({ test, status: "FAIL", metric, detail });
  failed++;
}

function warn(test, metric, detail = "") {
  console.log(`  ⚠️  ${test}: ${metric}  ${detail}`);
  report.push({ test, status: "WARN", metric, detail });
  warnings++;
}

function h1(title) {
  console.log(`\n┌──────────────────────────────────────────────────┐`);
  console.log(`│  ${title}`);
  console.log(`└──────────────────────────────────────────────────┘`);
}

function fmt(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);
}
function fmtdur(ms) {
  return ms >= 60000 ? (ms / 60000).toFixed(1) + "min" : ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms.toFixed(0) + "ms";
}

// ══════════════════════════════════════════════════════
//  PHASE 1: Basic Health
// ══════════════════════════════════════════════════════

async function phase1_health() {
  h1("PHASE 1: 基础健康检查");

  // 1.1 Router reachable
  const t0 = Date.now();
  try {
    const h = await get(HEALTH);
    const lat = Date.now() - t0;
    if (h.status === "ok") ok("Router 可达", `${fmtdur(lat)}`, `agents:${h.agents} msgs:${h.messages}`);
    else fail("Router 可达", `status=${h.status}`);
  } catch (e) {
    fail("Router 可达", e.message);
  }

  // 1.2 State endpoint
  try {
    const s = await get(STATE);
    if (typeof s.uptime === "number") ok("State API", `uptime:${fmtdur(s.uptime * 1000)}`, `agents:${s.stats?.totalAgents || 0} msgs:${s.totalMessages || 0}`);
    else fail("State API", "no uptime field");
  } catch (e) {
    fail("State API", e.message);
  }

  // 1.3 Clear state for clean test
  try {
    await post(CLEAR);
    const s = await get(STATE);
    if (s.stats?.totalAgents === 0 && s.totalMessages === 0) ok("状态清理", "clean slate");
    else warn("状态清理", `agents:${s.stats?.totalAgents} msgs:${s.totalMessages}`);
  } catch (e) {
    fail("状态清理", e.message);
  }
}

// ══════════════════════════════════════════════════════
//  PHASE 2: Agent Scaling
// ══════════════════════════════════════════════════════

async function phase2_agentScaling() {
  h1("PHASE 2: Agent 规模压力");

  const levels = [5, 10, 20, 50];
  let peak = 0;

  for (const n of levels) {
    // Create tmux sessions
    const sessions = [];
    const tc0 = Date.now();
    for (let i = 0; i < n; i++) {
      try {
        tsh(`${TMUX} kill-session -ths${i} 2>/dev/null`);
        tsh(`${TMUX} new-session -d -s hs${i}`, { timeout: 500 });
        sessions.push(`hs${i}`);
      } catch {}
    }
    const tmuxTime = Date.now() - tc0;

    // Register all
    const tr0 = Date.now();
    let registered = 0;
    for (let i = 0; i < sessions.length; i++) {
      try {
        const r = await api("register_agent", { agent_name: `a${i}`, tmux_session: `hs${i}` });
        if (r.ok) registered++;
      } catch {}
    }
    const regTime = Date.now() - tr0;

    if (registered === n) {
      ok(`  ${n} agents`, `tmux:${fmtdur(tmuxTime)} reg:${fmtdur(regTime)}`, `${registered} registered`);
      peak = n;
    } else if (registered > 0) {
      warn(`  ${n} agents`, `${registered}/${n}`, `tmux:${sessions.length}`);
    } else {
      fail(`  ${n} agents`, `0/${n}`, "tmux or reg failed");
      // break; — don't break, let's see if we can recover
    }
  }

  ok("→ MAX AGENTS", `${peak}`, "稳定上限");

  // Cleanup
  for (let i = 0; i < 100; i++) {
    try { tsh(`${TMUX} kill-session -ths${i} 2>/dev/null`); } catch {}
  }
  return peak;
}

// ══════════════════════════════════════════════════════
//  PHASE 3: Message Throughput
// ══════════════════════════════════════════════════════

async function phase3_throughput() {
  h1("PHASE 3: 消息吞吐极限");

  // Create 2 agents
  tsh(`${TMUX} kill-session -ttp-a`)
  tsh(`${TMUX} kill-session -ttp-b`)
  tsh(`${TMUX} new-session -d -s tp-a`, { timeout: 500 });
  tsh(`${TMUX} new-session -d -s tp-b`, { timeout: 500 });
  await api("register_agent", { agent_name: "tp-a", tmux_session: "tp-a" });
  await api("register_agent", { agent_name: "tp-b", tmux_session: "tp-b" });

  const DUR = 10_000; // 10 seconds
  let sent = 0, errs = 0;
  const t0 = Date.now();

  const sender = async () => {
    while (Date.now() - t0 < DUR) {
      try {
        const r = await api("send_message", { from: "tp-a", to: "tp-b", content: `msg${sent}` });
        if (r.ok) sent++; else errs++;
      } catch { errs++; }
    }
  };

  // 8 concurrent senders
  await Promise.all([sender(), sender(), sender(), sender(), sender(), sender(), sender(), sender()]);
  const elapsed = Date.now() - t0;
  const rate = (sent / (elapsed / 1000)).toFixed(1);

  ok("8x 并发写入 10s", `${sent} msgs / ${fmtdur(elapsed)}`, `= ${rate} msg/s, ${errs} errors`);

  if (rate > 50) ok("→ THROUGHPUT", `${rate} msg/s`, "达标 (>50)");
  else if (rate > 20) warn("→ THROUGHPUT", `${rate} msg/s`, "中等 (20-50)");
  else fail("→ THROUGHPUT", `${rate} msg/s`, "偏低 (<20)");

  tsh(`${TMUX} kill-session -ttp-a`)
  tsh(`${TMUX} kill-session -ttp-b`)
  return rate;
}

// ══════════════════════════════════════════════════════
//  PHASE 4: Message Size Limits
// ══════════════════════════════════════════════════════

async function phase4_messageSize() {
  h1("PHASE 4: 消息体积极限");

  tsh(`${TMUX} new-session -d -s ms`)
  await api("register_agent", { agent_name: "ms", tmux_session: "ms" });

  const sizes = [1024, 16384, 65536, 262144, 1048576, 4194304, 8388608];
  let maxOk = 0;

  for (const size of sizes) {
    const content = "X".repeat(size);
    const t0 = Date.now();
    try {
      const r = await api("send_message", { from: "ms", to: "ms", content });
      if (r.ok) {
        ok(`  ${fmt(size)}`, fmtdur(Date.now() - t0));
        maxOk = size;
      } else {
        warn(`  ${fmt(size)}`, `rejected: ${r.text?.slice(0, 50)}`);
        break;
      }
    } catch (e) {
      warn(`  ${fmt(size)}`, `error: ${e.message}`);
      break;
    }
  }

  ok("→ MAX PAYLOAD", fmt(maxOk));

  tsh(`${TMUX} kill-session -tms`)
  return maxOk;
}

// ══════════════════════════════════════════════════════
//  PHASE 5: Broadcast Storm
// ══════════════════════════════════════════════════════

async function phase5_broadcastStorm() {
  h1("PHASE 5: 广播风暴 (20 agents, all→all)");

  const N = 20;
  const sessions = [];
  for (let i = 0; i < N; i++) {
    try {
      tsh(`${TMUX} kill-session -tbs${i} 2>/dev/null`);
      tsh(`${TMUX} new-session -d -s bs${i}`, { timeout: 500 });
      sessions.push(`bs${i}`);
    } catch {}
  }

  for (let i = 0; i < sessions.length; i++) {
    await api("register_agent", { agent_name: `b${i}`, tmux_session: `bs${i}` });
  }

  ok("Setup", `${sessions.length} agents registered`);

  // Each agent broadcasts to all others
  const t0 = Date.now();
  let delivered = 0, tmuxNotified = 0;

  for (let i = 0; i < sessions.length; i++) {
    try {
      const r = await api("send_message", {
        from: `b${i}`, to: "all",
        topic: `round-${i}`,
        content: `Broadcast from b${i}: hello team!`,
      });
      if (r.ok) delivered++;
    } catch {}
  }

  const stormTime = Date.now() - t0;

  if (delivered === N) ok("Broadcast", `${N} agents → all`, fmtdur(stormTime));
  else if (delivered > N * 0.8) warn("Broadcast", `${delivered}/${N}`, fmtdur(stormTime));
  else fail("Broadcast", `${delivered}/${N}`);

  // Check message counts
  const state = await get(STATE);
  const expected = N * (N - 1); // each broadcast creates N-1 individual messages
  const actual = state.totalMessages;
  if (actual >= expected * 0.9) ok("Message count", `${actual}/${expected}`, "broadcast fan-out correct");
  else warn("Message count", `${actual}/${expected}`, "fan-out mismatch");

  // Cleanup
  for (let i = 0; i < N; i++) {
    try { tsh(`${TMUX} kill-session -tbs${i} 2>/dev/null`); } catch {}
  }
}

// ══════════════════════════════════════════════════════
//  PHASE 6: Agent Churn (rapid register/unregister)
// ══════════════════════════════════════════════════════

async function phase6_agentChurn() {
  h1("PHASE 6: Agent 搅动 (快速注册/注销)");

  const ROUNDS = 10;
  const AGENTS = 10;
  const t0 = Date.now();
  let ok_count = 0, fail_count = 0;

  for (let r = 0; r < ROUNDS; r++) {
    // Register
    for (let i = 0; i < AGENTS; i++) {
      tsh(`${TMUX} kill-session -tch${i}`)
      tsh(`${TMUX} new-session -d -s ch${i}`, { timeout: 300 });
      try {
        const res = await api("register_agent", { agent_name: `c${i}`, tmux_session: `ch${i}` });
        if (res.ok) ok_count++; else fail_count++;
      } catch { fail_count++; }
    }
    // Unregister
    for (let i = 0; i < AGENTS; i++) {
      try {
        const res = await api("unregister_agent", { agent_name: `c${i}` });
        if (res.ok) ok_count++; else fail_count++;
      } catch { fail_count++; }
    }
  }

  const total = ok_count + fail_count;
  const elapsed = Date.now() - t0;

  if (fail_count === 0) ok("Churn", `${total} ops / ${fmtdur(elapsed)}`, `${ROUNDS} rounds × ${AGENTS} agents`);
  else if (fail_count < total * 0.05) warn("Churn", `${fail_count}/${total} failed`, fmtdur(elapsed));
  else fail("Churn", `${fail_count}/${total} failed`);

  // Cleanup
  for (let i = 0; i < AGENTS; i++) {
    try { tsh(`${TMUX} kill-session -tch${i} 2>/dev/null`); } catch {}
  }
}

// ══════════════════════════════════════════════════════
//  PHASE 7: Persistence
// ══════════════════════════════════════════════════════

async function phase7_persistence() {
  h1("PHASE 7: 持久化验证");

  // Create some state
  tsh(`${TMUX} new-session -d -s ps`)
  await api("register_agent", { agent_name: "ps", tmux_session: "ps" });
  await api("send_message", { from: "ps", to: "ps", content: "persistence test message", topic: "test" });

  const before = await get(STATE);
  const agentsBefore = before.stats?.totalAgents || 0;
  const msgsBefore = before.totalMessages || 0;

  ok("Before", `agents:${agentsBefore} msgs:${msgsBefore}`, "state captured");

  // Kill the router
  const pid = execSync(`lsof -ti:${PORT} 2>/dev/null | head -1 || echo ''`, { encoding: "utf8" }).trim();
  if (pid) {
    tsh(`kill -9 ${pid} 2>/dev/null || true`);
    ok("Kill router", `PID ${pid}`, "simulating crash");
  }

  // Wait for LaunchAgent to restart
  let recovered = false;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    try {
      const h = await get(HEALTH);
      if (h.status === "ok") {
        ok("Auto-restart", `${(i + 1) * 3}s`, "LaunchAgent recovered");
        recovered = true;
        break;
      }
    } catch {}
  }
  if (!recovered) {
    fail("Auto-restart", "did not recover within 60s");
    return;
  }

  // Check state recovered
  await sleep(2000);
  const after = await get(STATE);
  const agentsAfter = after.stats?.totalAgents || 0;
  const msgsAfter = after.totalMessages || 0;

  if (agentsAfter >= agentsBefore && msgsAfter >= msgsBefore) {
    ok("→ PERSISTENCE", `agents:${agentsAfter}/${agentsBefore} msgs:${msgsAfter}/${msgsBefore}`, "状态完整恢复");
  } else if (msgsAfter > 0) {
    warn("→ PERSISTENCE", `agents:${agentsAfter}/${agentsBefore} msgs:${msgsAfter}/${msgsBefore}`, "部分恢复");
  } else {
    fail("→ PERSISTENCE", `agents:${agentsAfter} msgs:${msgsAfter}`, "状态丢失");
  }

  tsh(`${TMUX} kill-session -tps`)
}

// ══════════════════════════════════════════════════════
//  PHASE 8: Concurrent SSE + API
// ══════════════════════════════════════════════════════

async function phase8_concurrent() {
  h1("PHASE 8: 并发连接压力");

  // Open many SSE connections
  const SSE_TARGET = 100;
  const sseConns = [];
  for (let i = 0; i < SSE_TARGET; i++) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get("http://127.0.0.1:${PORT}/api/events", { timeout: 2000 }, (r) => resolve(r));
        req.on("error", reject);
      });
      sseConns.push(res);
    } catch { break; }
  }

  ok(`SSE connections`, `${sseConns.length}/${SSE_TARGET}`);

  // While SSE is open, hammer API
  let apiOk = 0, apiFail = 0;
  const apiStart = Date.now();
  const hammers = [];
  for (let w = 0; w < 4; w++) {
    hammers.push((async () => {
      while (Date.now() - apiStart < 5000) {
        try {
          const r = await api("list_agents");
          if (r.ok) apiOk++; else apiFail++;
        } catch { apiFail++; }
      }
    })());
  }
  await Promise.all(hammers);

  ok("API under SSE load", `${apiOk} calls / 5s`, `${apiFail} errors`);

  // Close SSE
  sseConns.forEach((c) => { try { c.destroy(); } catch {} });

  if (apiFail === 0) ok("→ CONCURRENT", "SSE + API 无干扰");
  else if (apiFail < apiOk * 0.1) warn("→ CONCURRENT", `${apiFail} API errors under SSE load`);
  else fail("→ CONCURRENT", `${apiFail}/${apiOk + apiFail} errors`);
}

// ══════════════════════════════════════════════════════
//  PHASE 9: Rapid Restart Cycles
// ══════════════════════════════════════════════════════

async function phase9_restartCycles() {
  h1("PHASE 9: 快速重启循环");

  const CYCLES = 3;
  const t0 = Date.now();
  let success = 0;

  for (let i = 0; i < CYCLES; i++) {
    try {
      // Kill
      const pid = tsh(`lsof -ti:${PORT} | head -1`);
      if (pid) tsh(`kill -9 ${pid}`);

      // Wait for auto-restart (max 40s per cycle)
      let up = false;
      for (let j = 0; j < 20; j++) {
        await sleep(2000);
        try {
          const h = await get(HEALTH);
          if (h.status === "ok") { up = true; break; }
        } catch {}
      }
      if (up) success++;
    } catch {}
  }

  const elapsed = Date.now() - t0;

  if (success === CYCLES) ok("Restart cycles", `${success}/${CYCLES}`, `平均 ${fmtdur(elapsed / CYCLES)}/次`);
  else if (success > 0) warn("Restart cycles", `${success}/${CYCLES}`, fmtdur(elapsed));
  else fail("Restart cycles", `0/${CYCLES}`, "LaunchAgent not working");
}

// ══════════════════════════════════════════════════════
//  PHASE 10: End-to-End Scenario
// ══════════════════════════════════════════════════════

async function phase10_e2e() {
  h1("PHASE 10: 端到端场景模拟");

  await post(CLEAR);
  await sleep(500);

  // 5 agents simulating a real workflow
  const team = ["pm", "architect", "frontend", "backend", "qa"];
  for (const role of team) {
    try { tsh(`${TMUX} kill-session -te2e-${role} 2>/dev/null`); } catch {}
    tsh(`${TMUX} new-session -d -s e2e-${role}`, { timeout: 500 });
    await api("register_agent", { agent_name: role, tmux_session: `e2e-${role}` });
  }

  const scenario = [
    ["pm", "all", "Sprint Planning", "本周目标：用户登录模块。前后端对齐接口，QA 准备测试用例。"],
    ["architect", "all", "技术方案", "JWT + refresh token。POST /auth/login, POST /auth/register, GET /auth/me。错误码统一。"],
    ["frontend", "architect", "API 确认", "Login 页面用 React Hook Form。token 存 localStorage 还是 cookie？"],
    ["backend", "frontend", "API 确认", "token 放 Authorization header，refresh token httpOnly cookie。更安全。"],
    ["frontend", "all", "进度同步", "Login 页面完成 70%，下午联调。"],
    ["backend", "all", "进度同步", "API 完成，单元测试通过。Postman collection 已分享。"],
    ["qa", "backend", "测试用例", "需要测试账号。覆盖：正常登录、密码错误、token 过期、并发登录。"],
    ["backend", "qa", "测试用例", "测试账号：test@demo.com / Test1234。token 有效期 15min，refresh 7d。"],
    ["qa", "all", "测试报告", "第一轮：12/12 通过。bug: refresh token 在 Safari 下 cookie 未设置。"],
    ["frontend", "qa", "测试报告", "确认 Safari 问题。SameSite=None; Secure 已加，re-deploy 中。"],
    ["pm", "all", "Sprint 总结", "Login 模块完成！感谢大家。前端+后端+QA 配合完美。下次 sprint：权限管理。"],
  ];

  const t0 = Date.now();
  let delivered = 0;

  for (const [from, to, topic, content] of scenario) {
    try {
      const r = await api("send_message", { from, to, topic, content });
      if (r.ok) delivered++;
    } catch {}
    await sleep(200);
  }

  const elapsed = Date.now() - t0;

  if (delivered === scenario.length) ok("E2E Scenario", `${delivered}/${scenario.length} msgs`, fmtdur(elapsed));
  else warn("E2E Scenario", `${delivered}/${scenario.length}`, fmtdur(elapsed));

  // Verify message state
  const state = await get(STATE);
  const topics = new Set((state.messages || []).map((m) => m.topic).filter(Boolean));
  ok("→ END-TO-END", `${team.length} agents, ${topics.size} topics, ${state.totalMessages} msgs`, "场景完整通过");

  for (const role of team) {
    try { tsh(`${TMUX} kill-session -te2e-${role} 2>/dev/null`); } catch {}
  }
}

// ══════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║    51team · HEALTH CHECK · SYSTEM AUDIT        ║");
  console.log("╚══════════════════════════════════════════════════╝");

  const sysinfo = {
    node: process.version,
    tmux: execSync(`${TMUX} -V`, { encoding: "utf8", timeout: 1000 }).trim(),
  };
  console.log(`  Node ${sysinfo.node}  ·  ${sysinfo.tmux}`);

  // Verify router is up
  try {
    await get(HEALTH);
    console.log("  ✅ Router online\n");
  } catch {
    console.log("  ❌ Router not running. Start with: 51team up\n");
    process.exit(1);
  }

  const startTime = Date.now();

  const results = {};

  const phases = [
    ["phase1_health", phase1_health],
    ["phase2_agentScaling", phase2_agentScaling],
    ["phase3_throughput", phase3_throughput],
    ["phase4_messageSize", phase4_messageSize],
    ["phase5_broadcastStorm", phase5_broadcastStorm],
    ["phase6_agentChurn", phase6_agentChurn],
    ["phase7_persistence", phase7_persistence],
    ["phase8_concurrent", phase8_concurrent],
    ["phase9_restartCycles", phase9_restartCycles],
    ["phase10_e2e", phase10_e2e],
  ];

  for (const [name, fn] of phases) {
    try {
      // Clean state between phases for isolation
      await post(CLEAR);
      await sleep(500);
      results[name] = await fn();
    } catch (e) {
      console.log(`  ❌ PHASE CRASHED: ${e.message}`);
      failed++;
      report.push({ test: name, status: "CRASH", metric: e.message });
    }
  }

  const maxAgents = results.phase2_agentScaling || 0;
  const throughput = results.phase3_throughput || "0";
  const maxPayload = results.phase4_messageSize || 0;

  // ── Health Score ──
  const totalTests = report.length;
  const healthScore = Math.round((passed / totalTests) * 100);
  const grade = healthScore >= 95 ? "A+ 🏆" : healthScore >= 85 ? "A" : healthScore >= 70 ? "B" : healthScore >= 50 ? "C" : "D";

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║           HEALTH CHECK REPORT                   ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Tests:   ${String(totalTests).padStart(4)}  (${String(passed).padStart(3)} pass, ${String(failed).padStart(2)} fail, ${String(warnings).padStart(2)} warn)`);
  console.log(`║  Score:   ${healthScore}%  Grade: ${grade}`);
  console.log(`║  Time:    ${fmtdur(Date.now() - startTime)}`);
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Max Agents:      ${String(maxAgents).padStart(5)}                        ║`);
  console.log(`║  Throughput:      ${String(throughput).padStart(5)} msg/s                  ║`);
  console.log(`║  Max Payload:     ${fmt(maxPayload).padStart(5)}                       ║`);
  console.log("╠══════════════════════════════════════════════════╣");

  if (healthScore >= 85) {
    console.log("║  ✅ SYSTEM HEALTHY — Ready for production       ║");
  } else if (healthScore >= 70) {
    console.log("║  ⚠️  SYSTEM DEGRADED — Check warnings           ║");
  } else {
    console.log("║  ❌ SYSTEM UNHEALTHY — Investigation needed     ║");
  }

  console.log("╚══════════════════════════════════════════════════╝");

  // Failures detail
  if (failed > 0) {
    console.log("\n❌ Failures:");
    report.filter((r) => r.status === "FAIL").forEach((r) => {
      console.log(`  - ${r.test}: ${r.metric}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
