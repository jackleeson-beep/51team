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

# ── Step 3: 在每个 session 中启动 Claude Code ──
echo ""
echo "[3/3] 🔄 启动 Claude Code agent..."

for role in "${ROLES[@]}"; do
  role=$(echo "$role" | xargs)
  SESSION="${PROJECT}-${role}"

  # 构建角色 prompt
  if [ -n "$TASK" ]; then
    PROMPT="你是 ${PROJECT} 的 ${role}。立即两步：1) register_agent agent_name='${role}' tmux_session='${SESSION}'；2) list_agents。然后用 send_message 与队友沟通。任务：${TASK}。收到 51team 通知立即 check_messages 然后 read_messages 阅读，用 send_message 回复。"
  else
    PROMPT="你是 ${PROJECT} 的 ${role}。立即两步：1) register_agent agent_name='${role}' tmux_session='${SESSION}'；2) list_agents。等待任务。收到 51team 通知立即 check_messages 然后 read_messages 阅读，用 send_message 回复。"
  fi

  # 启动 claude（自动处理信任弹窗）
  tmux send-keys -t "${SESSION}" "ANTHROPIC_MODEL=${MODEL} CLAUDE_CODE_EFFORT_LEVEL=${EFFORT} claude" Enter
  sleep 3
  tmux send-keys -t "${SESSION}" Enter

  # 等待 Claude Code 初始化完成
  echo "  等待 ${role} 初始化..."
  sleep 5

  # 发送初始 prompt
  tmux send-keys -t "${SESSION}" "${PROMPT}" Enter

  echo "  ✅ ${role} 已启动并收到任务"
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  🚀 团队就绪！                                  ║"
echo "╠══════════════════════════════════════════════════╣"
for role in "${ROLES[@]}"; do
  role=$(echo "$role" | xargs)
  echo "║  tmux attach -t ${PROJECT}-${role}  # ${role}"
done
echo "╠══════════════════════════════════════════════════╣"
echo "║  Web 面板: http://127.0.0.1:${ROUTER_PORT}/     ║"
echo "║  你的主 session 也用 MCP 工具协调:              ║"
echo "║    list_agents    - 查看队友                    ║"
echo "║    send_message   - 分配任务                    ║"
echo "║    check_messages - 检查消息                    ║"
echo "╚══════════════════════════════════════════════════╝"

# ── 自动打开 Web Dashboard ──
DASHBOARD_URL="http://127.0.0.1:${ROUTER_PORT}/"
if command -v open &>/dev/null; then
  open "${DASHBOARD_URL}" 2>/dev/null && echo "🌐 Dashboard 已打开: ${DASHBOARD_URL}"
elif command -v xdg-open &>/dev/null; then
  xdg-open "${DASHBOARD_URL}" 2>/dev/null
fi
