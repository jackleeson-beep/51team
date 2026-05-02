#!/bin/bash
# 51team 回归测试 — 覆盖所有历史 bug
# 跑完只需 5 秒（不依赖 tmux 和真实 Claude Code）
set -e

PORT="${MCP_BRIDGE_PORT:-9876}"
API="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1: $2"; }
curl_api() { curl -s -X POST "$API/api/call" -H 'Content-Type: application/json' -d "$1"; }

echo "═══ 51team 回归测试 ═══"

# ── 0. Router running ──
echo ""
echo "── Prerequisite: Router ──"
if curl -sf "$API/health" >/dev/null 2>&1; then
  ok "Router running"
else
  fail "Router not running" "start with: 51team up"
  exit 1
fi

# ── 1. Config validation ──
echo ""
echo "── 1. Config validation ──"

# Bug: enableAllProjectMcpServers 缺失导致 MCP tools 不加载
for cfg in "$HOME/.claude/settings.json" "$HOME/.claude-deepseek/settings.json"; do
  if [ -f "$cfg" ]; then
    if grep -q '"enableAllProjectMcpServers".*true' "$cfg" 2>/dev/null; then
      ok "$cfg has enableAllProjectMcpServers"
    else
      fail "$cfg missing enableAllProjectMcpServers"
    fi
    if grep -q '"enabledMcpjsonServers"' "$cfg" 2>/dev/null; then
      ok "$cfg has enabledMcpjsonServers"
    else
      fail "$cfg missing enabledMcpjsonServers"
    fi
  fi
done

# Bug: 51team MCP 配置缺失
for mcp in "$HOME/.claude/.mcp.json" "$HOME/.claude-deepseek/.mcp.json"; do
  if [ -f "$mcp" ]; then
    if grep -q '"51team"' "$mcp" 2>/dev/null; then
      ok "$mcp has 51team server"
    else
      fail "$mcp missing 51team server"
    fi
  fi
done

# Bug: --bare 启动缺少 --dangerously-skip-permissions
if grep -q 'dangerously-skip-permissions' team-up.sh 2>/dev/null; then
  ok "team-up.sh has --dangerously-skip-permissions"
else
  fail "team-up.sh missing --dangerously-skip-permissions"
fi

# ── 2. Router API - error paths ──
echo ""
echo "── 2. Router API error paths ──"

# Bug: API 空 body 返回 500（应返回 400）
EMPTY=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/call" -H 'Content-Type: application/json' -d '')
if [ "$EMPTY" = "400" ]; then
  ok "Empty body → 400"
else
  fail "Empty body → $EMPTY (expected 400)"
fi

# Bug: 畸形 JSON 应返回 400
BAD_JSON=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/call" -H 'Content-Type: application/json' -d 'not json')
if [ "$BAD_JSON" = "400" ]; then
  ok "Malformed JSON → 400"
else
  fail "Malformed JSON → $BAD_JSON (expected 400)"
fi

# Bug: 未知 tool 应返回 error
UNKNOWN=$(curl_api '{"tool":"nonexistent","args":{}}')
if echo "$UNKNOWN" | grep -q '"ok".*false'; then
  ok "Unknown tool → error"
else
  fail "Unknown tool → unexpected: $UNKNOWN"
fi

# ── 3. Store-Memory edge cases ──
echo ""
echo "── 3. Store edge cases ──"

# 准备
curl_api '{"tool":"unregister_agent","args":{"agent_name":"test-1"}}' >/dev/null
curl_api '{"tool":"unregister_agent","args":{"agent_name":"test-2"}}' >/dev/null

# 正常注册
REG1=$(curl_api '{"tool":"register_agent","args":{"agent_name":"test-1","tmux_session":"test-session"}}')
if echo "$REG1" | grep -q '"ok".*true'; then
  ok "register_agent"
else
  fail "register_agent: $REG1"
fi

# 重复注册应成功（幂等）
REG2=$(curl_api '{"tool":"register_agent","args":{"agent_name":"test-1","tmux_session":"test-session-2"}}')
if echo "$REG2" | grep -q '"ok".*true'; then
  ok "register_agent (dedup)"
else
  fail "register_agent (dedup): $REG2"
fi

# heartbeat
HB1=$(curl_api '{"tool":"heartbeat","args":{"agent_name":"test-1"}}')
if echo "$HB1" | grep -q '"ok".*true'; then
  ok "heartbeat"
else
  fail "heartbeat: $HB1"
fi

# heartbeat 未注册 agent → 应返回 ok=false
HB2=$(curl_api '{"tool":"heartbeat","args":{"agent_name":"never-existed"}}')
if echo "$HB2" | grep -q '"ok".*false'; then
  ok "heartbeat unregistered → false"
else
  fail "heartbeat unregistered: $HB2"
fi

# send_message 给未注册 agent → 应返回 ok=false
SEND1=$(curl_api '{"tool":"send_message","args":{"from":"test-1","to":"never-existed","content":"hi"}}')
if echo "$SEND1" | grep -q '"ok".*false'; then
  ok "send_message to unregistered → false"
else
  fail "send_message to unregistered: $SEND1"
fi

# send_message 正常
SEND2=$(curl_api '{"tool":"send_message","args":{"from":"test-1","to":"test-1","topic":"test","content":"hello"}}')
if echo "$SEND2" | grep -q '"ok".*true'; then
  ok "send_message"
else
  fail "send_message: $SEND2"
fi

# check messages
CHECK=$(curl_api '{"tool":"check_messages","args":{"agent_name":"test-1"}}')
if echo "$CHECK" | grep -q '"count".*[1-9]'; then
  ok "check_messages returns unread"
else
  fail "check_messages: $CHECK"
fi

# read_messages
READ=$(curl_api '{"tool":"read_messages","args":{"agent_name":"test-1"}}')
if echo "$READ" | grep -q '"count".*[1-9]'; then
  ok "read_messages"
else
  fail "read_messages: $READ"
fi

# read_messages 后 count 应为 0
CHECK2=$(curl_api '{"tool":"check_messages","args":{"agent_name":"test-1"}}')
if echo "$CHECK2" | grep -q '"count".*0'; then
  ok "check_messages after read → 0"
else
  fail "check_messages after read: $CHECK2"
fi

# list_agents
LIST=$(curl_api '{"tool":"list_agents","args":{}}')
if echo "$LIST" | grep -q '"count".*[1-9]'; then
  ok "list_agents"
else
  fail "list_agents: $LIST"
fi

# ── 4. SSE session lifecycle ──
echo ""
echo "── 4. SSE session lifecycle ──"

# 新 session
SSE=$(curl -sN --max-time 5 "$API/mcp" 2>&1 | grep -o 'sessionId=[a-f0-9-]*' | head -1 | cut -d= -f2)
if [ -n "$SSE" ]; then
  ok "SSE new session"
  # POST 到该 session（传入 sessionId）
  INIT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/mcp?sessionId=$SSE" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}')
  if [ "$INIT" = "202" ] || [ "$INIT" = "200" ]; then
    ok "POST initialize → $INIT"
  else
    fail "POST initialize → $INIT"
  fi
else
  fail "SSE new session" "no sessionId in response"
fi

# session 不存在 → 404
INVALID_S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/mcp?sessionId=noop" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":99,"method":"tools/list","params":{}}')
if [ "$INVALID_S" = "404" ]; then
  ok "Unknown sessionId → 404"
else
  fail "Unknown sessionId → $INVALID_S (expected 404)"
fi

# ── 5. Cleanup ──
echo ""
echo "── 5. Cleanup ──"
curl_api '{"tool":"unregister_agent","args":{"agent_name":"test-1"}}' >/dev/null
ok "cleanup done"

# ── Summary ──
echo ""
TOTAL=$((PASS+FAIL))
echo "═══ $PASS/$TOTAL passed${FAIL:+", $FAIL failed"} ═══"
exit $FAIL
