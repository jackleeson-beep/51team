# 51team

**我要 team** — MCP + tmux 多 Agent 协作框架。零外部依赖。

```bash
git clone https://github.com/jackleeson-beep/51team.git
cd 51team && ./install.sh
51team status
```

---

## 它做了什么

在 Claude Code 中开多个 tmux session，每个 session 跑一个独立 Claude Code agent。通过 MCP Router 让他们用 `send_message` / `check_messages` 协作，你在主 session 中用 MCP 工具当项目经理协调他们。

## 怎么让它不跑偏

51team 用两套 prompt 控制行为：

```
CLAUDE.md（项目根目录）                send-keys 注入（每个 agent 专属）
  主 session 加载                         tmux 中的 agent 收到
  "你只协调，不写代码"                     "你是 myapp 项目的 architect"
  "一次分配一个任务"                        "Step1 register_agent"
  "check_messages 看回复"                   "等待 coordinator 分配任务"
```

- **CLAUDE.md** 是给 Claude Code 主会话看的，告诉它怎么当好项目经理。你不需要背命令，只需一句话比如「组个队做用户系统」，CLAUDE.md 会指导它完成。
- **CORE_PROMPT** 通过 `team-up.sh` 经由 tmux send-keys 发给每个 agent，包含角色名、session 名、需执行的步骤和规则。每个 agent 收到的 prompt 都不一样。
- 两者同时发挥作用。缺少 CLAUDE.md，主 session 不知道该做什么。缺少 CORE_PROMPT，agent 不知道自己的角色。

## 架构

```
                     ┌──────────────────────┐
                     │   MCP Router :9876    │
                     │   · Agent 注册/消息   │
 tmux: project-      │   · SSE session 管理  │     tmux: project-
 architect           │   · Web Dashboard     │     frontend
     │               └──────────────────────┘         │
     │                      │    │                    │
     └────── send_message ──┘    └── SSE / JSON-RPC ──┘
```

- **Router** (`server-http.js`) — 手动实现 SSE + JSON-RPC，零外部依赖。每个 agent 独立 session，断连 30 秒内可重建。
- **tmux** — Agent 运行容器。send-keys 注入初始 prompt，Router 用 notifyAgent 推实时通知。
- **LaunchAgent** — macOS 开机自启，Router 崩溃后自动拉起。

## 安装

```bash
cd 51team
./install.sh
```

前提：Node.js ≥ 18、tmux（`brew install tmux`）

安装后 `~/.local/bin/51team` 已加入 PATH，`~/.claude/.mcp.json` 已写入 51team 的 MCP 配置。

## CLI 命令

| 命令 | 用途 |
|------|------|
| `51team up` | 启动 Router（幂等） |
| `51team down` | 停止 Router |
| `51team restart` | 重启 Router |
| `51team status` | 查看 Router 状态 + Agent 列表 |
| `51team ps` | 查看 Agent 在线/离线/过期状态 + 最后心跳 |
| `51team team <项目> <角色1,...> [任务]` | 一键组队 |
| `51team destroy [项目]` | 退出团队：杀掉 tmux session + 清状态 |
| `51team logs` | 实时日志 |
| `51team clean` | 清除所有 Router 状态 |
| `51team uninstall` | 卸载（删 symlink、LaunchAgent、状态文件） |
| `51team dashboard` | 打开 Web Dashboard |

## 使用

### 一句话组队

在 Claude Code 中说：

> 组个队做用户系统

CLAUDE.md 会引导 Claude Code 执行 `51team team`，创建 agent 团队，然后你可以：
1. `list_agents` 确认全员在线
2. `send_message(from='pm', to='all', ...)` 发布任务
3. `check_messages` 看 agent 回复

### 手动组队

```bash
51team team myapp "architect,frontend,backend,qa" "做一个用户登录模块"
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

杀掉该项目所有 tmux session + 清除 Router 状态。

## MCP 工具

| 工具 | 用途 |
|------|------|
| `register_agent` | Agent 启动时注册到 Router |
| `send_message` | 向其他 Agent 发消息（to='all' 广播） |
| `check_messages` | 查看未读消息 |
| `read_messages` | 读消息全文（自动标记已读） |
| `list_agents` | 列出所有 Agent 及在线状态 |
| `heartbeat` | 每 2 分钟心跳，否则 5 分钟自动注销 |

## 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `MCP_BRIDGE_PORT` | 9876 | Router 端口 |
| `ANTHROPIC_MODEL` | deepseek-v4-flash | Agent 模型 |
| `CLAUDE_CODE_EFFORT_LEVEL` | low | Agent effort 级别 |

## 设计要点

- **零外部依赖**（Node 标准库 only）
- **Agent TTL 5 分钟**，心跳间隔 2 分钟
- **消息上限 10,000**，超出自动修剪
- **Router 重启后消息不丢失**（state.json 持久化）
- **SSE session 断连 30 秒内可重建**，工具调用不中断

## 性能

在 Mac (Node 23 + tmux 3.6a) 上压测：

- 最大 Agent 数：50（推荐 ≤ 20）
- 最大消息体积：4.2 MB（推荐 ≤ 64KB）
- 吞吐量：74 msg/s（4 并发）

## License

MIT
