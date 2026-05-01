# 51team

### 我要 team · 五一劳动节 · 五指成拳 · 一个目标

> 让 Claude Code 的多个 Agent 像真正的团队一样实时对话、自主协作。  
> 基于 MCP + tmux，专为 DeepSeek V4 等多模型组合优化。

---

## 为什么叫 51team

- **5.1 劳动节** — 诞生于五一。Agent 替你劳动，你只管定方向
- **我要 team** — 每个开发者的心声。不要单打独斗，要有团队
- **5 指成拳** — 五指分散无力，握成拳头才有力量。多个 Agent 协同才能做出真正复杂的产品
- **1 个目标** — 不论几个 Agent、什么角色，围绕同一个任务。五人一志，无坚不摧

## 解决了什么问题

Claude Code 原生 Team Agent 在非 Anthropic 模型（如 DeepSeek V4）下，Agent 之间的 SendMessage 通讯不可靠：消息格式混乱、summary 丢失、idle 批处理延迟。

**51team 用 MCP Router + tmux send-keys 重建了 Agent 间的通讯层**：

```
Agent A ──→ send_message ──→ MCP Router ──→ tmux 通知 ──→ Agent B
                                    │
                              http://127.0.0.1:9876/
                              实时 Dashboard 可视化
```

- MCP Router 是中心消息路由（单进程，内存状态，无并发问题）
- tmux send-keys 将通知以"用户输入"方式实时注入目标 Agent 的终端
- Agent 收到通知后立即 check_messages / read_messages / send_message 回复

## 安装

```bash
cd 51team
./install.sh
```

前提：Node.js ≥ 18、tmux

## 使用

### 在 Claude Code 中说一句话

> "组个队：架构师、前端工程师、后端工程师，做一个用户管理系统"

Claude Code 会自动执行：
1. 确保 Router 在线
2. 为每个角色创建独立 tmux session
3. 启动 Claude Code agent 并注册到 Router
4. 打开 Web Dashboard

### 手动启动

```bash
# 确保 Router 运行（开机跑一次即可，后台常驻）
./router-up.sh

# 组队
./team-up.sh <项目名> "<角色1,角色2,...>" "[任务描述]"

# 示例
./team-up.sh myapp "architect,frontend,backend" "做一个任务管理系统"
```

### MCP 工具（Claude Code 中直接调用）

| 工具 | 用途 |
|------|------|
| `register_agent` | Agent 启动时注册到 Router |
| `send_message` | 向其他 Agent 发消息（to='all' 广播） |
| `check_messages` | 查看未读消息 |
| `read_messages` | 读消息全文（自动标记已读） |
| `list_agents` | 列出所有 Agent 及在线状态 |

### Web Dashboard

`http://127.0.0.1:9876/` — 实时查看 Agent 对话、在线状态、消息流。

## 架构

```
                     ┌──────────────────────┐
                     │   MCP Router :9876    │
                     │   · Agent 注册        │
 tmux: project-      │   · 消息路由          │     tmux: project-
 architect           │   · Web Dashboard     │     frontend
     │               └──────────────────────┘         │
     │                      │    │                    │
     └────── send_message ──┘    └── tmux notify ─────┘
```

## 性能

在 Mac (Node 23 + tmux 3.6a) 上压测结果：

- 最大 Agent 数：**50**
- 最大消息体积：**4.2 MB**
- 吞吐量：**77 msg/s**（4 并发）
- tmux 通知送达率：**100%**
- 并发 SSE 连接：**200+**

推荐：≤ 20 Agent、消息 ≤ 64KB。

## License

MIT
