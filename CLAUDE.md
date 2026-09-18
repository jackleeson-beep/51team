# 51team — 我要 team

MCP + tmux 多 Agent 协作框架。通过 `51team team` 命令创建 tmux Agent 团队，用 MCP 工具协调他们。

## 你的角色：项目经理

当用户说"组队做 X"，你**只协调，不写代码**。Agent 是执行者，你是 PM。

## 组队工作流

1. `51team up` — 确保 Router 运行
2. `51team team <项目名> '<角色1,角色2>' '<任务描述>'` — 不超过 5 个角色
3. 等待约 1-2 分钟（team-up.sh 自动等 Agent 就绪、注册、投规则）
4. 用 MCP 工具 `list_agents` 确认所有人已注册
5. `send_message(from='pm', to='auto'|具体角色, topic='kickoff', content='...')` 发布任务：
   - 有 `OPENROUTER_API_KEY` 或 `TYPESAFE_API_KEY` 时优先 `to='auto'`，让 Jev 按角色智能路由
   - 或 `route_message` 先预览分数，再定点发送
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
- Agent 可能主动向你报告方案变更或卡住，及时响应

## CLI 命令

```bash
51team up            # 启动 Router（幂等）
51team down          # 停止 Router（禁用自动恢复）
51team restart       # 重启 Router
51team status        # 查看 Router 状态 + Agent 列表
51team ps            # 查看 Agent 在线/离线/过期状态
51team team <项目> <角色1,角色2,...> [任务]   # 组队
51team destroy [项目] # 退出团队：杀掉 tmux session + 清除状态
51team logs          # 实时日志
51team clean         # 清除所有状态
51team uninstall     # 卸载：清状态、删 LaunchAgent、删 symlink
51team dashboard     # 打开 Web Dashboard
```

## MCP 工具

`register_agent` · `unregister_agent` · `send_message` · `check_messages` · `read_messages` · `list_agents` · `heartbeat` · `clear_all` · `jev_decide` · `route_message`

### Jev（TypeSafe System One）

设置 `OPENROUTER_API_KEY`（推荐，OpenRouter 免排队）或 `TYPESAFE_API_KEY` 后启用：

- `send_message(to='auto')` — 按内容+角色 noul 智能送达，避免无谓广播
- `route_message` — 只预览路由分数，不发送
- `jev_decide` — 通用结构化决策（noul / choice / score）
- `register_agent(..., role='...')` — 写入职责描述，提升路由准确度

```bash
export OPENROUTER_API_KEY=sk-or-...   # https://openrouter.ai/keys
# 或: export TYPESAFE_API_KEY=...    # https://console.typesafe.ai
51team restart
```

## 架构

```
Agent A ←→ tmux ←→ MCP Router (:9876) ←→ tmux ←→ Agent B
                         │
                   Web Dashboard
                         │
              Jev / TypeSafe API（可选）
```

- **MCP Router** (`server-http.js`) — 中心消息路由，手动 SSE + JSON-RPC，零外部依赖
- **tmux** — Agent 间通知通道，send-keys 注入终端
- **store-memory.js** — 内存存储 + JSON 持久化
- **jev.js** — TypeSafe Jev 客户端（原生 fetch，无 npm 依赖）

## 关键文件

| 文件 | 职责 |
|------|------|
| `51team` | 统一 CLI 入口 |
| `server-http.js` | Router：SSE + JSON-RPC + HTTP API + Dashboard |
| `store-memory.js` | 数据层：agents/messages CRUD，持久化，心跳 |
| `jev.js` | TypeSafe Jev System One 客户端 + 智能路由 |
| `tmux.js` | tmux：session 检测、send-keys、notifyAgent |
| `team-up.sh` | 一键组队：创建 tmux session、启动 Claude Code agent |
| `install.sh` | 安装：CLI symlink + LaunchAgent + MCP 配置 |

## 设计要点

- 零外部依赖（Node 标准库 only；Jev 用原生 fetch）
- Agent TTL 5 分钟，心跳间隔 2 分钟
- 消息上限 10,000，超出自动修剪
- Router 重启后消息不丢失（state.json 持久化）
- Jev 未配置时，`to=all` / 定点发送照常工作；`to=auto` / `jev_decide` 返回明确错误
