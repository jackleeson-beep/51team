#!/bin/bash
# 51team — 一键安装
set -e

echo "╔══════════════════════════════════════════╗"
echo "║       51team  — 我要 team               ║"
echo "║   MCP + tmux 多 Agent 协作框架          ║"
echo "╚══════════════════════════════════════════╝"
echo ""

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${MCP_BRIDGE_PORT:-9876}"
BIN_DIR="${HOME}/.local/bin"

# ── [1/5] Prerequisites ──
echo "[1/5] 检查依赖..."
command -v node >/dev/null 2>&1 || { echo "❌ 需要 Node.js ≥ 18"; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "❌ 需要 tmux: brew install tmux"; exit 1; }
echo "  ✅ Node $(node -v)  ·  tmux $(tmux -V)"

# ── [2/5] CLI to PATH ──
echo "[2/5] 安装 CLI..."
chmod +x "$DIR/51team" "$DIR/team-up.sh"
mkdir -p "$BIN_DIR"
ln -sf "$DIR/51team" "$BIN_DIR/51team"
echo "  ✅ 51team → ${BIN_DIR}/51team"

# ── [3/5] LaunchAgent ──
echo "[3/5] 安装 LaunchAgent..."
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
mkdir -p "$LAUNCH_DIR"
NODE_PATH="$(command -v node)"
cat > "$LAUNCH_DIR/com.51team.router.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.51team.router</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${DIR}/server-http.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/.claude/51team/launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.claude/51team/launchd.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>MCP_BRIDGE_PORT</key>
        <string>${PORT}</string>
    </dict>
</dict>
</plist>
PLIST
# Unload old then load new
launchctl bootout "gui/$(id -u)/com.51team.router" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_DIR/com.51team.router.plist" 2>/dev/null || true
echo "  ✅ Router 开机自启已设置"

# ── [4/5] MCP config ──
echo "[4/5] 配置 MCP..."
MCP_FILE="${HOME}/.claude/.mcp.json"
if [ ! -f "$MCP_FILE" ]; then
  echo '{"mcpServers": {}}' > "$MCP_FILE"
fi

node --input-type=commonjs -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$MCP_FILE', 'utf8'));
if (!config.mcpServers) config.mcpServers = {};
config.mcpServers['51team'] = {
  url: 'http://127.0.0.1:${PORT}/mcp',
  type: 'sse'
};
fs.writeFileSync('$MCP_FILE', JSON.stringify(config, null, 2) + '\n');
console.log('  ✅ MCP 配置已写入 ~/.claude/.mcp.json');
"

# ── Start Router ──
echo "启动 Router..."
"$BIN_DIR/51team" up
sleep 2
if curl -s "http://127.0.0.1:${PORT}/health" > /dev/null 2>&1; then
  echo "  ✅ Router 正常工作"
else
  echo "  ⚠️  Router 启动中，检查: 51team logs"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  🎉 51team 安装完成！                   ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  命令:  51team                           ║"
echo "║    up / down / restart / status          ║"
echo "║    team / logs / clean / dashboard       ║"
echo "║                                          ║"
echo "║  Router:  http://127.0.0.1:${PORT}/        ║"
echo "║  Dashboard: http://127.0.0.1:${PORT}/     ║"
echo "║                                          ║"
echo "║  开机自启: ✅ LaunchAgent                ║"
echo "║  CLI:      ~/.local/bin/51team           ║"
echo "║  日志:     ~/.claude/51team/router.log   ║"
echo "║                                          ║"
echo "║  任何 Claude Code 会话均可使用 MCP 工具: ║"
echo "║    list_agents / send_message / ...      ║"
echo "╚══════════════════════════════════════════╝"
