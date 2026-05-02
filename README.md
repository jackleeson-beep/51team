# 51team

**我要 team** — MCP + tmux 多 Agent 协作框架。零外部依赖。

```bash
git clone https://github.com/jackleeson-beep/51team.git
cd 51team && ./install.sh
51team status
```

---

## 它做了什么

在 Claude Code 中开多个 tmux session，每个 session 跑一个独立 Claude Code agent。通过 MCP Router 让他们用 `send_message` / `check_messages` 协作。agent 永不掉线，有消息就干活，没消息就安静挂着。你只需要一个主 session 说话，不用自己当项目经理。

## 工作方式：消息环

不是项目经理派活，是一个共享消息频道：

```
你 ──("给官网设计新风格")──→ Router ──→ designer（收到，开始画）
                                      ──→ engineer（收到，记着不管）
                                      ──→ seo（收到，记着不管）
designer ──("设计稿完成，需要实现")──→ Router ──→ engineer（收到，开始编码）
seo ──("导航结构变了，影响 SEO")──→ Router ──→ designer（收到，调整导航）
                                              ──→ engineer（收到，调整布局）
```

- 谁该说话谁说话
- 方案变了立刻通知相关人
- 卡住了开口问
- 没事做就安静挂着，不给自己找活

## Agent 怎么保证永不离线

tmux 里跑的其实是一个死循环：

```bash
while true; do
  claude --bare --dangerously-skip-permissions --mcp-config '{"51team":{"url":"..."}}' --strict-mcp-config
  sleep 3
done
```

Claude Code 退出后 3 秒自动重启，SSE session 30 秒内可重建，连接永续。不再有 5 分钟心跳 TTL 过期的问题。

## prompt 架构

51team 用两套 prompt 控制行为：

```
CLAUDE.md（项目根目录）                send-keys 注入（每个 agent 专属）
  主 session 加载                         tmux 中的 agent 收到
  "你只协调，不写代码"                     "你是设计师，持续在线"
  "send_message(to=all) 发任务"            "有人找你你就干活"
  "check_messages 看回复"                  "方案变了就开口"
```

- **CLAUDE.md** 告诉主 session 怎么用 Router 发消息、查状态。不需要背命令。
- **CORE_PROMPT** 通过 `team-up.sh` 经由 tmux send-keys 发给每个 agent，定义它的角色和行为规则。

## 安装

```bash
cd 51team
./install.sh
```

前提：Node.js ≥ 18、tmux（`brew install tmux`）

安装后 `~/.local/bin/51team` 加入 PATH，MCP 配置写入 `~/.claude/.mcp.json`。

## CLI 命令

| 命令 | 用途 |
|------|------|
| `51team up` | 启动 Router（幂等） |
| `51team down` | 停止 Router |
| `51team restart` | 重启 Router |
| `51team status` | 查看 Router 状态 + Agent 列表 |
| `51team ps` | 查看 Agent 在线/离线/心跳 |
| `51team team <项目> <角色,...> [任务]` | 组队（并行启动，永不离线） |
| `51team destroy <项目>` | 退出团队（杀 tmux + 只注销该项目 agent） |
| `51team logs` | 实时日志 |
| `51team clean` | 清除所有状态 |
| `51team uninstall` | 卸载（确认后清理全方位配置） |
| `51team dashboard` | Dashboard URL |

## 使用

### 一句话组队

在 Claude Code 中说：

> 组个队做官网

CLAUDE.md 会引导 Claude Code 执行 `51team team`，创建 agent 团队。然后你只需要发消息：

1. `send_message(from='pm', to='all', topic='kickoff', content='给官网设计新风格')`
2. agnet 收到后自动开工
3. 想看进展时 `check_messages`

### 手动组队

```bash
51team team myapp "designer,engineer,tester,seo"
```

启动后终端显示：

```
🚀 团队就绪！

  下一步（主 session 用 MCP 工具）:
    list_agents         确认全员在线
    send_message(to=all) 发布任务
    check_messages      看回复
  退出团队: 51team destroy myapp
```

### 退出团队

```bash
51team destroy myapp
```

只杀 myapp 的 tmux session、只注销 myapp 的 agent，不影响其他项目。

## MCP 工具

| 工具 | 用途 |
|------|------|
| `register_agent` | Agent 启动时注册到 Router |
| `send_message` | 发消息（to='all' 广播，或指定角色） |
| `check_messages` | 查看未读消息 |
| `read_messages` | 读消息全文（自动标记已读） |
| `list_agents` | 列出所有 Agent 及在线状态 |
| `heartbeat` | 心跳保活（agent 自动调用） |

## 架构

```
                     ┌──────────────────────┐
                     │   MCP Router :9876    │
                     │   · Agent 注册/消息   │
 tmux: project-      │   · SSE session 管理  │     tmux: project-
 designer            │   · Web Dashboard     │     engineer
     │               └──────────────────────┘         │
     │                      │    │                    │
     └────── send_message ──┘    └── SSE / JSON-RPC ──┘
```

- **Router**（`server-http.js`）— 手动实现 SSE + JSON-RPC，零外部依赖。每个 agent 独立 session，断连 30 秒内可重建。
- **tmux** — Agent 运行容器。`while true` 循环确保 claude 退出后自动重生。
- **LaunchAgent** — macOS 开机自启，Router 崩溃后自动拉起。

## 测试

```bash
# 回归测试（25 项，5 秒）
bash test-bugs-regression.sh

# Session resume 测试（~45 秒）
node test-session-resume.js

# 完整健康检查（~2 分钟）
node health-check.js
```

## 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `MCP_BRIDGE_PORT` | 9876 | Router 端口 |
| `ANTHROPIC_MODEL` | deepseek-v4-flash | Agent 模型 |
| `CLAUDE_CODE_EFFORT_LEVEL` | low | Agent effort |

## 设计要点

- **零外部依赖**（Node 标准库 only）
- **Agent 永不离线**（`while true` + SSE session resume）
- **消息上限 10,000**，超出自动修剪
- **Router 重启后消息不丢失**（state.json 持久化）
- **退出干净**：`destroy` 只杀指定项目，`uninstall` 全面清理

## License

MIT
