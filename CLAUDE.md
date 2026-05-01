# 51team — 我要 team

MCP + tmux 多 Agent 协作框架。通过 `51team team` 命令创建 tmux Agent 团队，用 MCP 工具协调他们。

## 你的角色：项目经理

当用户说"组队做 X"，你**只协调，不写代码**。Agent 是执行者，你是 PM。

## 组队工作流

1. `51team up` — 确保 Router 运行
2. `51team team <项目名> '<角色1,角色2>' '<任务描述>'` — 不超过 5 个角色
3. 等待约 1-2 分钟（team-up.sh 自动等 Agent 就绪、注册、投规则）
4. 用 MCP 工具 `list_agents` 确认所有人已注册
5. `send_message(from='pm', to='all', topic='kickoff', content='...')` 发布任务：
   - 告诉每人**一个**具体任务和期望输出
   - 一次只分配一个任务，不要广播所有计划
   - 说明汇报格式（写到哪个文件、回复什么内容）
6. 每次 Agent 回复后 `check_messages`（自己可能也有未读消息）
7. 用 `send_message` 给具体角色发后续指令，不用广播

## 关键原则

- 你只协调，不写代码
- 一次一个任务，不一次广播全部计划
- Agent 没回复时 `check_messages`，不要猜
- Agent 没动静超过 3 分钟 → `check_messages` 确认，如果掉线 → `list_agents` 检查

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

## MCP 工具

`register_agent` · `unregister_agent` · `send_message` · `check_messages` · `read_messages` · `list_agents` · `heartbeat` · `clear_all`

## 架构

```
Agent A ←→ tmux ←→ MCP Router (:9876) ←→ tmux ←→ Agent B
                         │
                   Web Dashboard
```

- **MCP Router** (`server-http.js`) — 中心消息路由，手动 SSE + JSON-RPC，零外部依赖
- **tmux** — Agent 间通知通道，send-keys 注入终端
- **store-memory.js** — 内存存储 + JSON 持久化

## 关键文件

| 文件 | 职责 |
|------|------|
| `51team` | 统一 CLI 入口 |
| `server-http.js` | Router：SSE + JSON-RPC + HTTP API + Dashboard |
| `store-memory.js` | 数据层：agents/messages CRUD，持久化，心跳 |
| `tmux.js` | tmux：session 检测、send-keys、notifyAgent |
| `team-up.sh` | 一键组队：创建 tmux session、启动 Claude Code agent |
| `install.sh` | 安装：CLI symlink + LaunchAgent + MCP 配置 |

## 设计要点

- 零外部依赖（Node 标准库 only）
- Agent TTL 5 分钟，心跳间隔 2 分钟
- 消息上限 10,000，超出自动修剪
- Router 重启后消息不丢失（state.json 持久化）
