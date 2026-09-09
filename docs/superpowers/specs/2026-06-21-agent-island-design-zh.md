# Agent Island — 个人项目设计文档

> 一个本地优先、始终置顶的 macOS 小组件，统一监控本机所有 AI 编码智能体（Claude Code、Codex、Cursor…），显示谁在跑、谁在等你、各自花了多少，并能一键跳回对应终端。

**创建日期：** 2026-06-21
**最后修订：** 2026-09-02
**当前版本：** v2
**状态：** M1 后端已实现（hook 待实机验证）

---

## 修订历史

| 版本 | 日期 | 摘要 |
|------|------|------|
| v1 | 2026-06-21 | 初版：Python 守护进程 + Claude Code `defer`/resume 循环 + SQLite |
| v2 | 2026-09-02 | 重大修订：改为纯 Electron；被动监控取代 defer 循环；引入多工具适配器架构；M1 去掉 SQLite；新增 Cowork 适配器（ADR-007） |

> **本文档是活文档。** 任何架构层面的改动，先在第 2 节「决策记录」追加一条 ADR，再改正文。正文永远描述当前状态，历史留在决策记录里。

---

## 1. 问题陈述

并发运行多个 AI 编码智能体时，缺乏统一视图来查看哪些在运行、哪些在等待审批、各自完成了什么、花了多少。逐个切换终端检查会打断工作流。

核心痛点：

1. **缺少统一可见性** — 多个工具（Claude Code / Codex / Cursor）、多个并发会话，没有一处能全看到
2. **不知道什么时候该回去** — agent 卡在审批上或已经跑完，你不切过去就不知道
3. **跨工具的用量分布不透明** — 今天在哪个项目、哪个工具上烧了多少 token

---

## 2. 决策记录

> 追加式。每条记录**为什么**这么定，以及它取代了什么。不要删除旧条目，用 `已被 ADR-00X 取代` 标记。

### ADR-001 · 放弃 `permissionDecision: "defer"` 循环
**日期：** 2026-09-02 · **状态：** 已采纳 · **取代：** v1 第 3 节

v1 的核心机制是 `PreToolUse` hook 返回 `defer` → Claude Code 以 `stop_reason: tool_deferred` 退出 → 守护进程写答案文件 → `claude -p --resume` 拉起会话。

**放弃原因：** `defer` 仅在非交互式 `-p` 模式下可用。产品定位已确定为**监控用户自己在终端手工启动的会话**（见 ADR-002），那些是交互式会话，`defer` 不适用。

**影响：** v1 第 3 节第一层、`island-relay.sh`、resume 循环全部作废。

---

### ADR-002 · 被动监控，不主动启动 agent 进程
**日期：** 2026-09-02 · **状态：** 已采纳

Agent Island **不**负责启动或托管任何 agent 进程。用户照常在自己的终端里启动 Claude Code / Codex，Island 只做三件事：**监控、提醒、跳转**。

**理由：** 这是用户的实际工作方式。托管进程会带来「输出去哪儿显示」「进程归属」等一系列问题，且剥夺了终端的交互能力。

**影响：** 「跳转回对应终端」成为核心功能而非附属功能，因为终端始终是真正的工作面。

---

### ADR-003 · 纯 Electron，取消独立 Python 守护进程
**日期：** 2026-09-02 · **状态：** 已采纳 · **取代：** v1 第 2 节、第 8 节

后端逻辑全部放在 Electron 主进程（Node.js）里，不再有独立的 Python 守护进程、launchd plist、FastAPI、SSE。

**理由：** 独立守护进程的唯一卖点是「关掉 UI 后端还活着」。但 ADR-002 之后 agent 跑在用户终端里、与 Island 完全独立，唯一损失是「UI 关闭期间的历史记录」——而会话记录一直在磁盘上，**下次启动重新扫描即可补齐**。用一个「启动时 catch-up 扫描」替代掉整个守护进程，代价小得多。

**代价：** 放弃了无头运行和未来做 CLI / 远程访问的便利。若将来需要，把 `src/core/` 单独跑起来即可，它本来就零 Electron 依赖。

---

### ADR-004 · 多工具适配器架构 + 能力分层
**日期：** 2026-09-02 · **状态：** 已采纳

每个 AI 工具实现一个 `AgentAdapter`。适配器**显式声明自己的能力**（`transcript` / `liveEvents` / `usage` / `approval`），UI 按能力决定显示什么。

**理由：** 三个工具能力差异巨大——Claude Code 和 Codex 都有会话记录 + hook 系统，Cursor 两样都没有。假装它们对等会让 UI 到处是空字段和假状态。

**为什么 M1 就写两个适配器：** 用单一样本设计抽象是通病。Claude Code 和 Codex 结构相似但 schema 不同，是验证抽象是否诚实的最小样本量。

---

### ADR-005 · M1 不使用数据库
**日期：** 2026-09-02 · **状态：** 已采纳 · **取代：** v1 第 4 节

M1 用内存状态 + 启动时扫盘补齐。定义 `SessionStore` 接口，M2 再加 `SqliteStore`。

**理由：** M1 阶段 `Session` 模型的 schema 还在探索中——各工具的用量字段、状态语义都不一样，模型会反复变。此时落 SQL schema 等于每改一次写一次迁移。等适配器写完、模型稳定再落库。

**备注：** `node:sqlite` 是 Node 22 内置模块（本机 v22.17.0 实测可用），**不需要** `better-sqlite3` 原生模块和 `electron-rebuild`。所以 M2 加数据库的成本很低，唯一未验证的是 Electron 打包的 Node 是否启用了该模块。

**约束：** 存储层必须从一开始就隔离在 `SessionStore` 接口后面，换实现时只动实例化那一行。

---

### ADR-006 · 岛上审批推迟到 M2
**日期：** 2026-09-02 · **状态：** 已采纳

M1 只做监控和提醒；在 Island 上直接点允许/拒绝推迟到 M2。

**技术路径（M2 用）：** `defer` 虽已放弃，但 `PreToolUse` hook 是**同步阻塞**的——hook 不返回，agent 就一直等（这本来就是它等审批时的状态，无额外损失）。所以 hook 可以长轮询 Island，用户点了就返回 `allow`/`deny`，终端审批 UI 根本不弹。必须有超时 fail-open，退回终端 UI 接管。

**推迟原因：** 这个 hook 会挂在**每一个**会话的**每次**工具调用上，写错了会卡住 agent。先把零风险的监控链路跑通。

---

### ADR-007 · Claude Desktop（Cowork）纳入，但不放 M1
**日期：** 2026-09-02 · **状态：** 已采纳

支持 Claude Desktop 的 Cowork / agent 模式，作为独立适配器，排在 M3（与 Cursor 适配器同批），而非 M1。

**成本很低：** Cowork 就是 Claude Code 跑在桌面 App 里，会话记录格式完全相同（`.claude/projects/**/*.jsonl`），解析器直接复用；再加一个扫 `claude-code-sessions/**/local_*.json` 侧车文件的目录扫描器即可。

**为什么仍然不放 M1：**
1. **验证不了抽象。** M1 写两个适配器的目的是检验 `AgentAdapter` 接口是否诚实。Cowork 与 Claude Code 同源同格式，是同类样本，学不到新东西。真正的压力测试来自 Codex（不同 schema）和 Cursor（不同形态）。
2. **实际使用频率低。** 实测最近的 Cowork 会话为 2026-08-27，agent-mode 为 2026-07-29；同期 Claude Code 与 Codex 是日常在用。
3. **存在未验证点**（Q5）：桌面 App 是否加载 `~/.claude/settings.json` 的 hook 未知。若不加载则只能轮询，是降级适配器——这种不确定性不该放在 M1 的关键路径上。

**成本低本身不是放进 M1 的理由。** M1 的价值在于用最小样本量验证架构，加东西只会稀释这个目标。

**明确排除：** 纯聊天产品（Claude 网页/App 对话、ChatGPT 对话）不纳入 —— 数据在服务端，本地无痕，且聊天是同步的，用户就在屏幕前，不需要提醒。

---

## 3. 架构

```
  用户终端里的 agent（照常运行，Island 不干预）
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │ Claude Code │  │    Codex    │  │   Cursor    │
   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                │                │
    会话记录 JSONL    会话记录 JSONL     state.vscdb
    + hooks           + hooks.json      （只能轮询）
          │                │                │
          └────────────────┼────────────────┘
                           ▼
   ┌───────────────────────────────────────────────┐
   │  Electron 主进程 (Node.js) — 即「后端」        │
   │   适配器注册表 → 各 AgentAdapter               │
   │   SessionStore（M1 内存 / M2 SQLite）          │
   │   hook 接收端点 127.0.0.1:7821                 │
   │   启动时 catch-up 扫描                          │
   └────────────────────┬──────────────────────────┘
                        │ Electron IPC
                        ▼
   ┌───────────────────────────────────────────────┐
   │  渲染进程 — React + Tailwind                   │
   │  无边框 · 始终置顶 · 系统托盘                   │
   └───────────────────────────────────────────────┘
```

**两条信息通道，互补：**

| 通道 | 提供什么 | 局限 |
|------|---------|------|
| **会话记录文件**（tail JSONL） | 标题、cwd、token、花费、在干什么 | 判断不出「卡在审批上」——记录里看不出停顿的原因 |
| **hook 事件**（HTTP → 7821） | 状态转换：running / waiting / complete | 只有事件，没有内容 |

两者用 `session_id` 关联。缺任何一条，状态机都不完整。

---

## 4. 适配器模型

```ts
interface AgentAdapter {
  id: string                  // 'claude-code' | 'codex' | 'cursor' | 'kimi' …
  displayName: string
  capabilities: {
    transcript: boolean       // 有会话记录可解析
    liveEvents: boolean       // 有 hook 系统，能实时知道状态转换
    usage: boolean            // 有 token / 花费数据
    approval: boolean         // 能拦截审批（M2）
  }
  detect(): Promise<boolean>            // 本机装了没
  install(): Promise<void>              // 幂等安装 hook
  uninstall(): Promise<void>            // 精确移除自己的 hook 条目
  scan(): Promise<Session[]>            // 启动时补齐历史
  watch(emit: EventSink): Disposable    // 增量监听
}
```

统一会话模型，各工具往这里映射：

```ts
type Session = {
  id: string
  tool: string
  title: string | null        // claude-code: ai-title | codex: thread_name
  cwd: string
  status: 'running' | 'waiting' | 'idle' | 'complete' | 'error'
  startedAt: number
  updatedAt: number
  usage?: { inputTokens: number; outputTokens: number; costUSD?: number }
  waitingOn?: { toolName: string; summary: string }   // M2
}
```

### 能力矩阵

| 工具 | transcript | liveEvents | usage | approval | 里程碑 |
|------|:---:|:---:|:---:|:---:|:---:|
| Claude Code | ✅ | ✅ | ✅ | ✅ | M1 |
| Codex | ✅ | ✅ | ✅ | ✅ | M1 |
| Claude Desktop（Cowork） | ✅ 同 Claude Code 格式 | ⚠️ 待验证 | ✅ | ❓ | M3 |
| Cursor | ⚠️ 私有 schema | ❌ | ❌ | ❌ | M3 |
| Kimi 等 | 待查 | | | | 未来 |

**UI 契约：** 渲染时按 `capabilities` 分支。`usage: false` 的工具不显示花费栏位，不显示 `—` 占位；`liveEvents: false` 的工具只显示「活动中 / 空闲」这种粗粒度状态，不承诺 `waiting`。

**接入新工具（如 Kimi）的三个问题：** 会话记录在哪？什么格式？有没有 hook 系统？有 hook 就是完整能力，没有就降级成轮询卡片。

---

## 5. 各工具数据源（2026-09-02 实测）

### Claude Code

```
~/.claude/projects/<cwd 编码后的目录名>/<session-uuid>.jsonl
```

JSONL 行类型及可用字段：

| 行 `type` | 提供 |
|-----------|------|
| `ai-title` | `aiTitle` — **Claude Code 自己生成的标题**，直接用，无需额外 API 调用 |
| `cost-state` | `totalCostUSD`、`modelUsage{每模型 input/output/cache token}`、`totalDuration`、`totalLinesAdded/Removed` |
| `assistant` | `message.usage`（每轮 token）、`message.model`、`message.stop_reason`、`timestamp` |
| `user` / `assistant` | `cwd`、`gitBranch`、`sessionId` — 跳转终端靠这个 |
| `system` | `stopReason`、`toolUseID`、`hookInfos` |

Hook 配置：`~/.claude/settings.json`（**用户级**，非项目级——要监控所有会话）。

### Codex

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
~/.codex/session_index.jsonl     ← {id, thread_name, updated_at}，启动扫描走这里，快
~/.codex/hooks.json              ← hook 配置
```

| 行 `type` / `payload.type` | 提供 |
|-----------|------|
| `session_meta` | `session_id`、`cwd`、`cli_version`、`model_provider`、`source` |
| `event_msg: task_started` | 开始跑 — 状态机信号 |
| `event_msg: task_complete` | `duration_ms`、`last_agent_message`、`time_to_first_token_ms` |
| `event_msg: token_count` | `info`、`rate_limits` |
| `turn_context` | `cwd`、`workspace_roots`、`approval_policy` |

Hook 事件：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / **`PermissionRequest`**。最后一个是专门的审批事件，比 Claude Code 更直接。

### Cursor（M3）

```
~/Library/Application Support/Cursor/User/workspaceStorage/<workspace-hash>/state.vscdb
```

SQLite，schema 未公开且随 Cursor 版本变化。无 hook 系统、无事件流，**只能轮询 + diff**。定位为**尽力而为的降级适配器**：只显示「某项目正在活动」，不承诺状态精度。读取用纯 JS 的 `sql.js`（WASM），不引原生模块。

### Claude Desktop / Cowork（M3，见 ADR-007）

Cowork 本质就是 **Claude Code 跑在桌面 App 里**，会话记录格式与 Claude Code 完全相同，解析器可直接复用。

```
~/Library/Application Support/Claude/
  claude-code-sessions/<org>/<user>/local_<uuid>.json      ← 每会话一个 5KB 元数据侧车文件
  local-agent-mode-sessions/<org>/<user>/local_<uuid>/
      .claude/projects/<encoded>/<uuid>.jsonl              ← 与 Claude Code 格式一致
      audit.jsonl                                          ← 额外的审计事件流
```

**侧车文件 `local_<uuid>.json`** 几乎直接就是一个 `Session`：

| 字段 | 用途 |
|------|------|
| `sessionId` / `cliSessionId` | 后者指向底层 Claude Code 会话记录 |
| `cwd` / `originCwd` | 跳转终端（但 Cowork 在 App 里，跳转语义需另行设计） |
| `title` / `titleSource` | 标题现成（`titleSource: "auto"`） |
| `model` / `effort` / `permissionMode` | 展示用 |
| `createdAt` / `lastActivityAt` / `lastFocusedAt` | 状态与排序 |
| `isArchived` / `completedTurns` | 生命周期 |

**`audit.jsonl` 的 `result` 行**提供 `total_cost_usd`、`modelUsage`、`usage`、`stop_reason`、`num_turns`、`duration_ms`。

**未验证：** 桌面 App 是否加载 `~/.claude/settings.json` 里的 hook。若不加载，`liveEvents: false`，只能靠 `lastActivityAt` 与文件 mtime 轮询，降级为粗粒度状态。

### 明确不支持：纯聊天产品

Claude 网页/App 对话、ChatGPT 对话**监控不了**——对话在服务端，本地不落盘（`~/Library/Application Support/com.openai.chat/` 实测只有 `app_pairing_extensions/`）。

而且它们本来也不该上这个 Island：Island 的价值是「agent 在后台跑、我需要知道它啥时候要我」。聊天是同步的，用户就坐在屏幕前。

---

## 6. 存储

M1 内存实现，接口先隔离好：

```ts
interface SessionStore {
  upsert(s: Session): void
  get(id: string): Session | undefined
  list(filter?: { tool?: string; status?: Session['status'] }): Session[]
  recordEvent(e: SessionEvent): void
}
```

- **M1** — `MemoryStore`。启动时各适配器 `scan()` 补齐历史，运行时 `watch()` 增量更新。
- **M2** — `SqliteStore`（`node:sqlite`）。换实现只动实例化那一行。落库的触发条件：模型稳定，且启动扫描变慢到影响体验。

**扫描性能约束：** 本机现有 22 个 Claude Code 会话共 16MB、69 个 Codex 会话。启动时**不全量解析**——按 mtime 只完整解析最近 N 个（默认最近 7 天），更老的走索引文件或惰性加载。

**v1 的 SQL schema 已作废**（见 ADR-005）。M2 落库时按当时稳定的 `Session` / `SessionEvent` 类型重新设计。

---

## 7. 内部接口

ADR-003 之后不再有跨进程 HTTP API + SSE。只剩两个接口：

### hook 接收端点（唯一的 HTTP 面）

```
POST http://127.0.0.1:7821/hook
{ "tool": "claude-code", "event": "PreToolUse", "sessionId": "...", "cwd": "...", "payload": {...} }
```

hook 脚本调用约束：

- **超时 2 秒、fail-open** — Island 没跑就静默退出，绝不能影响 agent
- 只上报，不阻塞（M1）；M2 的审批走长轮询，另设端点

### 主进程 → 渲染进程（Electron IPC）

```ts
ipcMain → 'sessions:snapshot'   // 全量，首次渲染用
ipcMain → 'sessions:updated'    // 增量，单个 Session
ipcMain → 'sessions:removed'
```

---

## 8. UI 设计

**三种显示状态：**

```
[收起] 系统托盘图标，显示需要注意的会话数量徽标

[普通] 顶部边缘浮动胶囊
  ┌────────────────────────────────────────────┐
  │ ● claude-code  重构认证中间件      12m     │
  │ ⏸ codex        等待审批: rm -rf ./dist     │
  │ ● cursor       FlowPilot 活动中             │
  └────────────────────────────────────────────┘

[展开] 点击某个会话
  ┌────────────────────────────────────────────┐
  │ claude-code · GildedRose updateQuality 重构 │
  │ ~/ME/CMU/Courses/Refactoring/GildedRose     │
  │ $2.79 · 32k out · 12m41s                    │
  │                          [跳转终端]         │
  └────────────────────────────────────────────┘
```

- `always-on-top` + `frameless` + 透明背景
- **跳转终端**：按 `cwd` 用 AppleScript 激活 Terminal / iTerm 中对应的窗口或标签页
- 历史抽屉：已完成会话、按工具和项目分组的今日用量

**M2 审批态：**

```
  ┌────────────────────────────────────────────┐
  │ codex 想要运行：                            │
  │ $ rm -rf ./dist                             │
  │                      [拒绝]      [允许]     │
  └────────────────────────────────────────────┘
```

---

## 9. 技术栈

| 层级 | 技术 |
|------|------|
| 核心（`src/core/`） | TypeScript，**零 Electron 依赖** — 可用 `node` 直接跑 |
| 文件监听 | `chokidar`，增量读取（记录 offset，只解析新增字节） |
| 存储 | M1 内存 · M2 `node:sqlite`（Node 内置，无原生模块） |
| 读 Cursor 的 SQLite | `sql.js`（WASM），M2 |
| 桌面外壳 | Electron |
| 前端 | React + Tailwind CSS |
| 测试 | Vitest + 真实会话记录截取的 fixture |
| 打包 | electron-builder → `.dmg` |
| 自启动 | `app.setLoginItemSettings()` |

**核心原则：** `src/core/` 不 import electron。这样后端可以脱离 Electron 独立开发和测试，`npm run dev` 起一个无头 CLI 就能验证全部逻辑。

---

## 10. 里程碑

### M1 — 后端跑通（无 UI）

- [x] 项目脚手架：TypeScript + tsx + Vitest，从真实会话截取 fixture
- [x] `Session` / `SessionEvent` 类型 + `SessionStore` 接口 + `MemoryStore`
- [x] `AgentAdapter` 接口 + 能力声明
- [x] Claude Code 适配器：JSONL 解析 → 扫描 → 增量监听
- [x] Codex 适配器：同上（验证抽象是否诚实）
- [x] hook 接收端点 + 统一 relay 脚本（幂等 merge 安装 / 卸载）
- [x] 无头 CLI `npm run dev`：终端实时打印状态流
- [ ] **待你验证**：装上 hook，跑真实会话，确认 running → waiting → complete 的流转

**M1 完成的判据：** 另开终端跑一个真实的 Claude Code 会话和一个 Codex 会话，CLI 里能实时看到 running → waiting → complete 的状态流转，以及正确的标题、cwd、用量。

### M2 — Electron UI

- [ ] Electron 外壳：无边框、始终置顶、系统托盘
- [ ] 胶囊 UI + 展开态（React + Tailwind）
- [ ] 跳转终端（AppleScript）
- [ ] 历史抽屉 + 用量统计
- [ ] 登录时自启动

### M3 — 功能补全

- [ ] 岛上点审批（hook 长轮询 + 超时 fail-open，见 ADR-006）
- [ ] `SqliteStore` 持久化
- [ ] Claude Desktop（Cowork）适配器 — 复用 Claude Code 解析器 + 侧车文件扫描
- [ ] Cursor 适配器（降级模式）

### M4 — 开源就绪

- [ ] 一键安装 / 卸载脚本（hook 的幂等 merge 与精确移除）
- [ ] 适配器开发文档（如何接入新工具）
- [ ] README、演示录屏
- [ ] `.dmg` 发布

---

## 11. 待决问题

| # | 问题 | 状态 |
|---|------|------|
| Q1 | ~~Claude Desktop（Cowork）是否纳入？~~ | **已解决 2026-09-02** — 纳入，排 M2。见 ADR-007 |
| Q5 | Cowork 是否加载 `~/.claude/settings.json` 的 hook？决定它的 `liveEvents` 能力 | M3 前验证 |
| Q2 | Electron 打包后的 Node 是否可用 `node:sqlite`？ | 待验证，M2 前解决。退路：`sql.js` |
| Q3 | 跳转终端如何定位到具体的 Terminal/iTerm 标签页？ | M2 前调研。按 cwd 匹配可能不唯一 |
| Q4 | Cursor 的 `state.vscdb` schema | M3 前逆向 |

---

## 12. 已知风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| Hook 位已被占用 — `~/.claude/settings.json` 有 litmus；`~/.codex/hooks.json` 有 armorCodex + litmus；`~/.codex/config.toml` 的 `notify` 是**单槽位**且已被 Codex Computer Use 占用 | 安装脚本覆盖会破坏用户现有工具 | 幂等 merge，自己的条目打 `"_island": 1` 标记（litmus 用 `"_litmus": 1`）；Codex 走 `hooks.json` 而非 `notify`；卸载时按标记精确移除 |
| 会话记录格式随工具版本变化 | 解析失败、字段缺失 | 解析器容错设计：未知行类型跳过而非抛错；fixture 锁定已知格式；适配器上报「格式异常」而非崩溃 |
| Cursor schema 逆向后被上游改动搞崩 | Cursor 适配器失效 | 定位为尽力而为；失效时降级为「检测到 Cursor 但无法读取」，不影响其他适配器 |
| hook 脚本拖慢每次工具调用 | agent 变慢 | 超时 2 秒、fail-open；M1 只上报不阻塞 |

---

## 13. 超出范围（V2+）

- 桌宠 / 皮肤
- 自定义音效
- Windows / Linux 支持
- 云同步 / 团队共享
- 纯聊天产品监控（技术上不可行，见第 5 节）
- 主动启动 / 托管 agent 进程（见 ADR-002）
