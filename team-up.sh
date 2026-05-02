#!/bin/bash
# ────────────────────────────────────────────────
# team-up — 一键启动 MCP + tmux Agent 团队
#
# 用法:
#   ./team-up.sh <项目名> <角色列表> [任务描述]
#
# 示例:
#   ./team-up.sh user-mgmt "architect,frontend,backend" "做一个用户管理系统"
#
# 角色名 = agent 名 = tmux session 名 = agent-<角色>
# ────────────────────────────────────────────────
set -e

# ── Plan A: 就绪检测 — 轮询 capture-pane 直到 Claude Code 显示提示符 ──
wait_for_claude_ready() {
  local session="$1"
  local max_wait="${2:-60}"
  local ready=0
  for i in $(seq 1 $max_wait); do
    sleep 1
    # Claude Code 提示符特征：行首有 > 或 ⏣ 或 ╭ 或 thinking 指示器
    if tmux capture-pane -t "$session" -p 2>/dev/null | tail -20 | grep -qE '(^\s*(❯|>|⏣|╭|╰|●|%|#)|Enter a prompt|Start a conversation|Error:)' 2>/dev/null; then
      ready=1
      break
    fi
  done
  return $(( 1 - ready ))
}

PROJECT="${1:?用法: team-up.sh <项目名> <角色1,角色2,...> [任务描述]}"
IFS=',' read -ra ROLES <<< "$2"
TASK="${3:-}"
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROUTER_PORT="${MCP_BRIDGE_PORT:-9876}"
ROUTER_URL="http://127.0.0.1:${ROUTER_PORT}/mcp"

# Configurable model and effort level
MODEL="${ANTHROPIC_MODEL:-deepseek-v4-flash}"
EFFORT="${CLAUDE_CODE_EFFORT_LEVEL:-low}"

echo "╔══════════════════════════════════════════════════╗"
echo "║  51team — 我要 team               ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  项目:   ${PROJECT}"
echo "║  角色:   ${ROLES[*]}"
echo "║  任务:   ${TASK:-未指定}"
echo "║  51team: ${ROUTER_URL}"
echo "╚══════════════════════════════════════════════════╝"

# ── Step 1: 启动 51team Router (如果没跑) ──
if curl -s "http://127.0.0.1:${ROUTER_PORT}/health" > /dev/null 2>&1; then
  echo ""
  echo "[1/3] ✅ 51team Router 已在运行"
else
  echo ""
  echo "[1/3] 🔄 启动 51team Router..."
  node "${BRIDGE_DIR}/server-http.js" &
  ROUTER_PID=$!
  sleep 2
  if curl -s "http://127.0.0.1:${ROUTER_PORT}/health" > /dev/null 2>&1; then
    echo "[1/3] ✅ 51team Router 已启动 (PID: ${ROUTER_PID})"
  else
    echo "[1/3] ❌ 51team Router 启动失败"
    exit 1
  fi
fi

# ── Step 2: 创建 tmux session ──
echo ""
echo "[2/3] 🔄 创建 tmux session..."

for role in "${ROLES[@]}"; do
  role=$(echo "$role" | xargs) # trim whitespace
  SESSION="${PROJECT}-${role}"

  # 杀掉旧 session
  tmux kill-session -t "${SESSION}" 2>/dev/null || true

  # 创建新 session (不启动任何命令，保持 shell)
  tmux new-session -d -s "${SESSION}"

  # 设置环境变量
  tmux setenv -t "${SESSION}" AGENT_NAME "${role}"
  tmux setenv -t "${SESSION}" AGENT_ROLE "${role}"
  tmux setenv -t "${SESSION}" TEAM_PROJECT "${PROJECT}"
  tmux setenv -t "${SESSION}" TMUX_SESSION "${SESSION}"
  tmux setenv -t "${SESSION}" MCP_ROUTER_URL "${ROUTER_URL}"

  echo "  ✅ ${role} → session: ${SESSION}"
done

# ── Step 3a: 在所有 session 中启动 Claude Code（并行）──
echo ""
echo "[3/3] 🔄 启动 Claude Code agent..."

# MCP config: 只连 51team，不加载其他 MCP server
MCP_JSON=$(printf '{"mcpServers":{"51team":{"url":"http://127.0.0.1:%s/mcp","type":"sse"}}}' "$ROUTER_PORT")

for role in "${ROLES[@]}"; do
  role=$(echo "$role" | xargs)
  tmux send-keys -t "${PROJECT}-${role}" \
    "ANTHROPIC_MODEL=${MODEL} CLAUDE_CODE_EFFORT_LEVEL=${EFFORT} claude --bare --mcp-config '${MCP_JSON}' --strict-mcp-config" Enter
done

# ── Step 3b: 统一消除权限弹窗 ──
sleep 3
for role in "${ROLES[@]}"; do
  role=$(echo "$role" | xargs)
  tmux send-keys -t "${PROJECT}-${role}" Enter
done

# ── Step 3c: 并行等待就绪 + 发送 prompt ──
# 规则直接合并到 CORE_PROMPT，不需要额外的 python3 轮询投递
for role in "${ROLES[@]}"; do
  (
    role=$(echo "$role" | xargs)
    SESSION="${PROJECT}-${role}"

    if [ -n "$TASK" ]; then
      PROMPT="你是 ${PROJECT} 项目的 ${role}。严格按顺序：Step1 call register_agent agent_name='${role}' tmux_session='${SESSION}'。Step2 call list_agents。Step3 call send_message from='${role}' to='all' content='自我介绍：我是${role}，已就位，等待任务'。关键规则：1) 每次回复后主动 check_messages agent_name='${role}'; 2) 每 2 分钟 heartbeat agent_name='${role}'，否则 5 分钟自动注销; 3) 沟通就是生产力——方案变更、技术选型变化、卡住超过 3 分钟，立即向相关角色（包括 coordinator）报告，不要自己纠结。然后等待 coordinator 分配任务，收到前不要自行开始。"
    else
      PROMPT="你是 ${PROJECT} 项目的 ${role}。严格按顺序：Step1 call register_agent agent_name='${role}' tmux_session='${SESSION}'。Step2 call list_agents。Step3 call send_message from='${role}' to='all' content='已就位，等待 coordinator 分配任务'。关键规则：1) 每次回复后主动 check_messages agent_name='${role}'; 2) 每 2 分钟 heartbeat agent_name='${role}'，否则 5 分钟自动注销; 3) 沟通就是生产力——方案变更、技术选型变化、卡住超过 3 分钟，立即向相关角色（包括 coordinator）报告，不要自己纠结。然后等待 coordinator 分配任务，收到前不要自行开始。"
    fi

    if wait_for_claude_ready "$SESSION" 120; then
      tmux send-keys -t "${SESSION}" "${PROMPT}"
      sleep 0.5 2>/dev/null || sleep 1
      tmux send-keys -t "${SESSION}" Enter
      # wait for Claude Code to process prompt + call register_agent, then dismiss permission popup
      sleep 10
      for _ in 1 2 3; do
        tmux send-keys -t "${SESSION}" Enter
        sleep 2
      done
      echo "  ✅ ${role} 就绪"
    else
      tmux send-keys -t "${SESSION}" "${PROMPT}"
      sleep 1
      tmux send-keys -t "${SESSION}" Enter
      sleep 10
      for _ in 1 2 3; do
        tmux send-keys -t "${SESSION}" Enter
        sleep 2
      done
      echo "  ⚠️  ${role} 超时，已尝试发送 prompt"
    fi
  ) &
done
wait

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  🚀 团队就绪！                                  ║"
echo "╠══════════════════════════════════════════════════╣"
for role in "${ROLES[@]}"; do
  role=$(echo "$role" | xargs)
  echo "║  tmux attach -t ${PROJECT}-${role}  # ${role}"
done
echo "╠══════════════════════════════════════════════════╣"
echo "║  下一步（主 session 用 MCP 工具）:              ║"
echo "║    list_agents         确认全员在线              ║"
echo "║    send_message(to=all) 发布任务                ║"
echo "║    check_messages      看回复                   ║"
echo "║  退出团队: 51team destroy ${PROJECT}             ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Dashboard: http://127.0.0.1:${ROUTER_PORT}/     ║"
echo "╚══════════════════════════════════════════════════╝"

# ── Dashboard 提示 ──
echo "🌐 Dashboard: http://127.0.0.1:${ROUTER_PORT}/   (浏览器打开即可查看实时通讯)"
