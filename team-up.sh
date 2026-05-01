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
    if tmux capture-pane -t "$session" -p 2>/dev/null | tail -20 | grep -qE '(^\s*(❯|>|⏣|╭|╰|●)|Enter a prompt|Start a conversation)' 2>/dev/null; then
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

# ── Step 3: 在每个 session 中启动 Claude Code ──
echo ""
echo "[3/3] 🔄 启动 Claude Code agent..."

for role in "${ROLES[@]}"; do
  role=$(echo "$role" | xargs)
  SESSION="${PROJECT}-${role}"

  # ── Plan B: 结构化 prompt，防止 Claude Code 跑偏 ──
  # 关键：agent 必须等 coordinator 分配任务，不能自行开始
  if [ -n "$TASK" ]; then
    CORE_PROMPT="你是 ${PROJECT} 项目的 ${role}。严格按顺序：Step1 call register_agent agent_name='${role}' tmux_session='${SESSION}'。Step2 call list_agents 查看队友。Step3 call send_message from='${role}' to='all' content='自我介绍：我是${role}，负责[能力说明]，等待任务分配'。Step4 call check_messages agent_name='${role}' 查看系统规则。然后等待 coordinator 通过 send_message 分配具体任务。收到任务前不要自行开始。每次回复后主动 check_messages。"
  else
    CORE_PROMPT="你是 ${PROJECT} 项目的 ${role}。严格按顺序：Step1 call register_agent agent_name='${role}' tmux_session='${SESSION}'。Step2 call list_agents 查看队友。Step3 call send_message from='${role}' to='all' content='已就位，等待 coordinator 分配任务'。Step4 call check_messages agent_name='${role}' 查看系统规则。然后等待 coordinator 通过 send_message 分配任务。收到任务前不要自行开始。每次回复后主动 check_messages。"
  fi

  # 第二段：规则指令 — 不通过 send-keys，改为 Router 消息投递（避免干扰 agent）
  # 注意：不要用单引号，会破坏 python3 -c 的字符串
  RULES_MSG="系统规则：1) 每次回复后主动 check_messages agent_name=${role}，有未读消息立即 read_messages 并回复；2) 每 2 分钟 heartbeat agent_name=${role}，否则 5 分钟后自动注销。记住：主动轮询，不等待通知。"


  # 启动 claude
  tmux send-keys -t "${SESSION}" "ANTHROPIC_MODEL=${MODEL} CLAUDE_CODE_EFFORT_LEVEL=${EFFORT} claude" Enter

  # 3 秒后发 Enter 消除可能的权限弹窗（不阻塞就绪检测）
  sleep 3
  tmux send-keys -t "${SESSION}" Enter

  # ── Plan A: 主动检测 Claude Code 就绪状态，替代固定 sleep ──
  echo "  等待 ${role} 初始化（最多 120 秒）..."
  if wait_for_claude_ready "$SESSION" 120; then
    # Claude Code 已就绪，发送核心指令
    tmux send-keys -t "${SESSION}" "${CORE_PROMPT}"
    sleep 0.5 2>/dev/null || sleep 1
    tmux send-keys -t "${SESSION}" Enter
    echo "  ✅ ${role} 已就绪，核心指令已发送"
  else
    # ── Fix 3: 超时二次确认，去掉多余 Enter ──
    echo "  ⚠️  ${role} 就绪检测超时，二次确认..."
    if tmux capture-pane -t "${SESSION}" -p 2>/dev/null | tail -3 | grep -qE '(❯|>|⏣|Enter a prompt)'; then
      tmux send-keys -t "${SESSION}" "${CORE_PROMPT}"
      sleep 1
      tmux send-keys -t "${SESSION}" Enter
      echo "  ✅ ${role} 二次确认后发送成功"
    else
      tmux send-keys -t "${SESSION}" "${CORE_PROMPT}"
      sleep 1
      tmux send-keys -t "${SESSION}" Enter
      echo "  ❌ ${role} 可能未就绪，prompt 已发送但可能需要手动 Enter"
    fi
  fi

  # 等 agent 注册后投递规则
  # 时序：注册检测每 2 秒轮询，agent 在 register_agent 后还要 list_agents、发送自我介绍
  # 规则在注册后 2 秒内投递，agent 会在后续 check_messages 中看到
  echo "  等待 ${role} 注册 + 投递规则..."
  RULES_ROLE="${role}" RULES_CONTENT="${RULES_MSG}" RULES_PORT="${ROUTER_PORT}" python3 -c "
import os, urllib.request, json, time
role = os.environ['RULES_ROLE']
content = os.environ['RULES_CONTENT']
port = os.environ['RULES_PORT']
msg = json.dumps({'tool': 'send_message', 'args': {'from': 'system', 'to': role, 'topic': 'rules', 'content': content}}).encode()
for _ in range(120):
    time.sleep(1)
    try:
        state = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state').read())
        if any(a['name'] == role for a in state.get('agents', [])):
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/api/call', data=msg, headers={'Content-Type': 'application/json'}))
            print(f'  \U0001f4cb {role} 已注册，规则已投递')
            break
    except:
        pass
" 2>/dev/null
  # 规则已投递，nudge agent 立即检查
  sleep 1
  tmux send-keys -t "${SESSION}" "call check_messages agent_name='${role}'" Enter
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
