# 51team — 我要 team

MCP + tmux 多 Agent 协作框架。让 Claude Code 的多个 Agent 像团队一样实时通讯、自主协作。

任何 Claude Code 会话中均可使用 MCP 工具（list_agents, send_message 等）。
Router 通过 macOS LaunchAgent 开机自启，崩了自动拉。

## 架构

```
Agent A ←→ tmux ←→ MCP Router (:9876) ←→ tmux ←→ Agent B
                         │
                   Web Dashboard
```

- **MCP Router** (`server-http.js`) — 中心消息路由，单进程，内存状态
- **tmux** — Agent 间通知通道，send-keys 注入终端
- **store-memory.js** — 内存存储 + JSON 持久化 (`~/.claude/51team/state.json`)
- **LaunchAgent** — `~/Library/LaunchAgents/com.51team.router.plist`，install.sh 自动生成，开机自启

## CLI 命令

```bash
51team up            # 启动 Router（幂等）
51team down          # 停止 Router
51team restart       # 重启 Router
51team status        # 查看状态 + Agent 列表
51team team <项目> <角色1,角色2,...> [任务]   # 组队
51team logs          # 实时日志
51team clean         # 清除所有状态
51team dashboard     # 打开 Web Dashboard
```

CLI 本身位于项目目录下的 `51team` 脚本，install.sh 会 symlink 到 `~/.local/bin/51team`。

## 关键文件

| 文件 | 职责 |
|------|------|
| `51team` | 统一 CLI 入口 |
| `server-http.js` | Router 主程序：MCP Server + HTTP API + Dashboard HTML |
| `store-memory.js` | 数据层：agents/messages CRUD，修剪，持久化，心跳 |
| `tmux.js` | tmux 交互：session 检测、send-keys、notifyAgent |
| `team-up.sh` | 一键组队：创建 tmux session、启动 Claude Code agent |
| `stress-test.js` | 压力测试：7 项，覆盖 agent 规模/消息/吞吐/SSE |
| `health-check.js` | 综合健康检查：10 项，含持久化/并发/重启恢复/E2E |
| `install.sh` | 安装脚本（npm + CLI symlink + 动态生成 LaunchAgent + MCP 配置） |

## API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/mcp` | GET/POST | MCP SSE/StreamableHTTP |
| `/api/call` | POST | 直接调用 MCP 工具 `{tool, args}` |
| `/api/state` | GET | 完整状态快照 |
| `/api/clear` | POST | 重置状态（测试用） |
| `/api/events` | GET | SSE 实时事件流 |
| `/health` | GET | 健康检查 |

## MCP 工具

`register_agent` · `unregister_agent` · `send_message` · `check_messages` · `read_messages` · `list_agents` · `heartbeat` · `clear_all`

## 设计决策

- **不引入外部依赖**：Router 只用 Node 标准库 + `@modelcontextprotocol/sdk` + `zod`
- **无并发锁**：单进程 Map/Array，事件循环天然串行
- **tmux 路径不硬编码**：`tmux.js` 启动时自动检测 `command -v` → 常见路径 fallback
- **消息上限 10,000**：超出自动修剪最早的消息
- **持久化截断 64KB/条**：防止大消息撑爆状态文件
- **Agent TTL 5 分钟**：心跳超时自动注销，防止死 agent 堆积
- **Dashboard 内联 HTML**：零外部资源，单文件自包含

## 性能基线

- 最大 Agent 数：50（推荐 ≤ 20）
- 最大消息体积：4.2 MB（推荐 ≤ 64KB）
- 吞吐量：74 msg/s（4 并发）
- tmux 送达率：100%
- 并发 SSE：200+

## 注意事项

- tmux 是必须依赖（Mac: `brew install tmux`）
- team-up.sh 默认模型 `deepseek-v4-flash`，通过 `ANTHROPIC_MODEL` 环境变量覆盖
- team-up.sh 默认 effort `low`，通过 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量覆盖
- Router 重启后消息不丢失（自动从 state.json 恢复）
- Dashboard SSE 断连后 5 秒自动重连，回退到 5 秒轮询
