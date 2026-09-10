# Agent Island — Personal Project Design Spec

> A local-first, always-on-top macOS widget that gives one unified view of every AI coding agent on your machine (Claude Code, Codex, Cursor…) — who's running, who's waiting on you, what each has spent — with one click back to the right terminal.

**Created:** 2026-06-21
**Last revised:** 2026-09-02
**Version:** v2
**Status:** M1 backend implemented (hooks pending live verification)

---

## Revision History

| Version | Date | Summary |
|---------|------|---------|
| v1 | 2026-06-21 | Initial: Python daemon + Claude Code `defer`/resume loop + SQLite |
| v2 | 2026-09-02 | Major revision: pure Electron; passive monitoring replaces the defer loop; multi-tool adapter architecture; SQLite dropped from M1; Cowork adapter added (ADR-007) |

> **This is a living document.** Any architectural change gets an ADR appended to §2 *first*, then the body is updated. The body always describes the current state; history lives in the decision log.

---

## 1. Problem Statement

When running multiple AI coding agents concurrently, there is no unified view of which are running, which are waiting for approval, what they've accomplished, or what they've cost. Checking each terminal individually breaks focus.

Core pain points:

1. **No unified visibility** — multiple tools (Claude Code / Codex / Cursor), multiple concurrent sessions, nowhere to see them all
2. **No signal for when to go back** — an agent stuck on approval or already finished is invisible until you switch to it
3. **Cross-tool usage is opaque** — which project, which tool, how many tokens today

---

## 2. Decision Log

> Append-only. Each entry records **why**, and what it supersedes. Don't delete old entries — mark them `Superseded by ADR-00X`.

### ADR-001 · Drop the `permissionDecision: "defer"` loop
**Date:** 2026-09-02 · **Status:** Accepted · **Supersedes:** v1 §3

v1's core mechanism was a `PreToolUse` hook returning `defer` → Claude Code exits with `stop_reason: tool_deferred` → daemon writes an answer file → `claude -p --resume` revives the session.

**Why dropped:** `defer` only works in non-interactive `-p` mode. The product is now scoped to **monitoring sessions the user starts by hand in their own terminal** (see ADR-002) — those are interactive, so `defer` does not apply.

**Impact:** v1 §3 Tier 1, `island-relay.sh`, and the entire resume loop are void.

---

### ADR-002 · Passive monitoring; never launch agent processes
**Date:** 2026-09-02 · **Status:** Accepted

Agent Island does **not** launch or supervise any agent process. The user starts Claude Code / Codex in their own terminal as usual. Island does three things: **monitor, notify, jump**.

**Why:** This matches how the user actually works. Supervising processes raises "where does output go" and "who owns the process" problems, and strips the terminal of its interactivity.

**Impact:** "Jump to terminal" becomes a core feature rather than a nicety, because the terminal is always where the real work happens.

---

### ADR-003 · Pure Electron; no separate Python daemon
**Date:** 2026-09-02 · **Status:** Accepted · **Supersedes:** v1 §2, §8

All backend logic lives in the Electron main process (Node.js). No standalone Python daemon, no launchd plist, no FastAPI, no SSE.

**Why:** The only selling point of a separate daemon was "the backend survives closing the UI." But after ADR-002, agents run in the user's terminal, fully independent of Island. The only loss is history recorded while the UI is closed — and the transcripts are on disk the whole time, so a **catch-up scan on next launch** recovers it. One startup scan replaces an entire daemon at a fraction of the cost.

**Cost:** Gives up headless operation and easy future CLI / remote access. If needed later, `src/core/` can run standalone — it has zero Electron dependencies by design.

---

### ADR-004 · Multi-tool adapter architecture with capability tiers
**Date:** 2026-09-02 · **Status:** Accepted

Each AI tool implements an `AgentAdapter`. Adapters **explicitly declare their capabilities** (`transcript` / `liveEvents` / `usage` / `approval`), and the UI branches on them.

**Why:** The three tools differ enormously — Claude Code and Codex both have transcripts *and* hook systems; Cursor has neither. Pretending they're equivalent litters the UI with empty fields and fake states.

**Why two adapters in M1:** Designing an abstraction from a single example is the classic mistake. Claude Code and Codex are structurally similar but schema-different — the minimum sample size for an honest abstraction.

---

### ADR-005 · No database in M1
**Date:** 2026-09-02 · **Status:** Accepted · **Supersedes:** v1 §4

M1 uses in-memory state plus a startup disk scan. A `SessionStore` interface is defined now; `SqliteStore` lands in M2.

**Why:** The `Session` schema is still being discovered in M1 — usage fields and status semantics differ per tool, and the model will churn. Committing to SQL now means writing a migration for every change. Land the schema once the adapters are written and the model has settled.

**Note:** `node:sqlite` is built into Node 22 (verified working on this machine, v22.17.0) — **no** `better-sqlite3` native module, **no** `electron-rebuild`. Adding a DB in M2 is therefore cheap; the one unverified question is whether Electron's bundled Node enables the module.

**Constraint:** Storage must sit behind the `SessionStore` interface from day one, so swapping implementations touches exactly one line.

---

### ADR-006 · Approval-from-the-island deferred to M2
**Date:** 2026-09-02 · **Status:** Accepted

M1 is monitoring and notification only. Clicking Allow/Deny on the island is deferred.

**Technical path (for M2):** `defer` is gone, but `PreToolUse` hooks are **synchronous and blocking** — if the hook doesn't return, the agent waits (which is exactly what it does while awaiting approval anyway, so nothing is lost). The hook can long-poll Island; when the user clicks, it returns `allow`/`deny` and the terminal approval UI never appears. A timeout with fail-open is mandatory so the terminal UI takes over.

**Why deferred:** This hook sits on **every** tool call in **every** session. Get it wrong and agents hang. Ship the zero-risk monitoring path first.

---

### ADR-007 · Claude Desktop (Cowork) included, but not in M1
**Date:** 2026-09-02 · **Status:** Accepted

Claude Desktop's Cowork / agent mode gets its own adapter, in M3 (alongside the Cursor adapter) rather than M1.

**The cost is low:** Cowork is Claude Code running inside the desktop app, with an identical transcript format (`.claude/projects/**/*.jsonl`) — the parser is reused as-is. All that's needed on top is a scanner for the `claude-code-sessions/**/local_*.json` metadata sidecars.

**Why still not M1:**
1. **It doesn't test the abstraction.** The point of writing two adapters in M1 is to check whether `AgentAdapter` is honest. Cowork shares Claude Code's lineage and format — it's a same-family sample and teaches nothing new. The real stress tests are Codex (different schema) and Cursor (different shape entirely).
2. **Low actual usage.** Most recent Cowork session observed: 2026-08-27; agent-mode: 2026-07-29. Claude Code and Codex are in daily use over the same period.
3. **An unverified dependency** (Q5): whether the desktop app loads hooks from `~/.claude/settings.json` is unknown. If it doesn't, the adapter is poll-only and degraded — that uncertainty doesn't belong on M1's critical path.

**Low cost is not by itself a reason to pull something into M1.** M1's value is validating the architecture with the minimum sample size; additions only dilute that.

**Explicitly excluded:** pure chat products (Claude web/app conversations, ChatGPT conversations) — server-side data with nothing on disk, and chat is synchronous anyway: the user is already looking at it and needs no notification.

---

### ADR-008 · Hook events get a persisted append-only log; session state is not event-sourced
**Date:** 2026-09-08 · **Status:** Accepted · **Refines:** ADR-005

Hook events are recorded to a durable append-only log that lands together with `SqliteStore`. Session state remains a mutable record derived from transcripts — it is **not** reconstructed by replaying that log.

**Why persist hook events:** They are the only evidence Island holds that is not already on disk. A transcript records what an agent did; a hook records what it was *blocked on* and *when it stopped* — `waiting` and `complete` have no other source (see `status.ts`). Today a `HookEvent` is folded into a `Session` and dropped, so how long an approval sat unanswered, the moment a turn ended, and how often a session was interrupted all die when the process exits. Every question worth asking later — mean time blocked, which tool stalls most, how many turns ran today, the activity timeline — needs exactly this data and cannot recover it afterwards.

**Why not event-source session state:**

1. **The transcripts already are the append-only log.** ADR-003 depends on this: a catch-up scan on next launch recovers history without Island having stored anything. A second log carrying the same facts is a second source of truth, and the two will disagree.
2. **`reduce(log) → state` fights the scan bound in §6.** Startup deliberately parses only the most recent transcripts, newest first, capped. Rebuilding state from a full event history either ignores that bound or needs snapshots to restore it — cost with no matching benefit at this scale.
3. **The one local win is already had.** The problem event sourcing would solve here — a transcript re-read clobbering a hook-set `waiting` — is handled in `mergeSession`.

**What is logged:** the normalized `HookEvent` plus the status transition it caused. Not `SessionEvent` store deltas: `session_updated` says the record changed, not what happened.

**Consequences:**

- `SessionStore.recordEvent()` / `events()` have no consumer today. They stay — this ADR is their specification — and get one when the store lands. Until then they are knowingly dead code, not an oversight.
- Retention is bounded and left unspecified until there is a real row count to reason about.
- Nothing on the running path may depend on the log being writable. The hook script's fail-open contract (§7) is unchanged: a log that cannot be written is a lost row, never a stalled agent.
- No requirement is added to M1 or M2.

---

## 3. Architecture

```
  Agents in the user's terminal (running normally; Island does not intervene)
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │ Claude Code │  │    Codex    │  │   Cursor    │
   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                │                │
    JSONL transcript  JSONL transcript   state.vscdb
    + hooks           + hooks.json       (poll only)
          │                │                │
          └────────────────┼────────────────┘
                           ▼
   ┌───────────────────────────────────────────────┐
   │  Electron main process (Node.js) = "backend"  │
   │   adapter registry → AgentAdapter each        │
   │   SessionStore (memory M1 / SQLite M2)        │
   │   hook receiver endpoint 127.0.0.1:7821       │
   │   catch-up scan on startup                    │
   └────────────────────┬──────────────────────────┘
                        │ Electron IPC
                        ▼
   ┌───────────────────────────────────────────────┐
   │  Renderer — React + Tailwind                  │
   │  frameless · always-on-top · system tray      │
   └───────────────────────────────────────────────┘
```

**Two complementary information channels:**

| Channel | Provides | Limitation |
|---------|----------|------------|
| **Transcript files** (tail JSONL) | Title, cwd, tokens, cost, what it's doing | Can't tell "stuck on approval" — a pause looks the same as any other pause |
| **Hook events** (HTTP → 7821) | State transitions: running / waiting / complete | Events only, no content |

Correlated by `session_id`. Neither channel alone yields a complete state machine.

---

## 4. Adapter Model

```ts
interface AgentAdapter {
  id: string                  // 'claude-code' | 'codex' | 'cursor' | 'kimi' …
  displayName: string
  capabilities: {
    transcript: boolean       // has a parseable transcript
    liveEvents: boolean       // has a hook system for real-time state transitions
    usage: boolean            // exposes token / cost data
    approval: boolean         // can intercept approvals (M2)
  }
  detect(): Promise<boolean>            // installed on this machine?
  install(): Promise<void>              // idempotent hook installation
  uninstall(): Promise<void>            // surgically remove only our entries
  scan(): Promise<Session[]>            // backfill history on startup
  watch(emit: EventSink): Disposable    // incremental tail
}
```

Unified session model that each tool maps into:

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

### Capability Matrix

| Tool | transcript | liveEvents | usage | approval | Milestone |
|------|:---:|:---:|:---:|:---:|:---:|
| Claude Code | ✅ | ✅ | ✅ | ✅ | M1 |
| Codex | ✅ | ✅ | ✅ | ✅ | M1 |
| Claude Desktop (Cowork) | ✅ same format as Claude Code | ⚠️ unverified | ✅ | ❓ | M3 |
| Cursor | ⚠️ private schema | ❌ | ❌ | ❌ | M3 |
| Kimi, others | TBD | | | | Future |

**UI contract:** Render by branching on `capabilities`. A tool with `usage: false` shows no cost field at all — not a `—` placeholder. A tool with `liveEvents: false` shows only coarse "active / idle" and never claims `waiting`.

**Three questions for onboarding a new tool (e.g. Kimi):** Where is the transcript? What format? Is there a hook system? Hooks mean full capability; no hooks means a degraded poll-only card.

---

## 5. Data Sources (verified 2026-09-02)

### Claude Code

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

| Line `type` | Provides |
|-------------|----------|
| `ai-title` | `aiTitle` — **Claude Code generates the title itself**; use it directly, no extra API call |
| `cost-state` | `totalCostUSD`, `modelUsage{per-model input/output/cache tokens}`, `totalDuration`, `totalLinesAdded/Removed` |
| `assistant` | `message.usage` (per-turn tokens), `message.model`, `message.stop_reason`, `timestamp` |
| `user` / `assistant` | `cwd`, `gitBranch`, `sessionId` — the basis for jump-to-terminal |
| `system` | `stopReason`, `toolUseID`, `hookInfos` |

Hook config: `~/.claude/settings.json` (**user level**, not project level — we monitor all sessions).

**Titles have three sources** (verified 2026-09-09). `ai-title` is not the only one; relying on it alone leaves a large share of sessions showing `(untitled)`:

1. **Desktop sidecar** — `~/Library/Application Support/Claude/claude-code-sessions/<org>/<user>/local_*.json`, field `title`. Sessions launched from Claude Desktop write the same transcripts under `~/.claude/projects/` but **emit no `ai-title` row**; the sidecar's `cliSessionId` is that transcript's session id. `titleSource: "auto"` marks it as tool-generated, as trustworthy as `aiTitle`.
2. **`ai-title` rows** — used by terminal sessions, but only after several turns.
3. **First `user` row's text**, first line, truncated. Fallback only — note that `user` rows also carry tool results (`content` is an array whose blocks have `type: "tool_result"`); those are not a prompt and must never become a title.

### Codex

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
~/.codex/session_index.jsonl     ← {id, thread_name, updated_at}; fast startup scan
~/.codex/hooks.json              ← hook config
```

| Line `type` / `payload.type` | Provides |
|-------------|----------|
| `session_meta` | `session_id`, `cwd`, `cli_version`, `model_provider`, `source` |
| `event_msg: task_started` | Turn started — state machine signal |
| `event_msg: task_complete` | `duration_ms`, `last_agent_message`, `time_to_first_token_ms` |
| `event_msg: token_count` | `info`, `rate_limits` |
| `turn_context` | `cwd`, `workspace_roots`, `approval_policy` |

Hook events: `SessionStart` / `UserPromptSubmit` / `PreToolUse` / **`PermissionRequest`**. That last one is a dedicated approval event — more direct than anything Claude Code offers.

**Codex Desktop is a degraded case of the same adapter** (verified 2026-09-09). It writes the same rollouts (`session_meta.originator = "Codex Desktop"`, `source: "vscode"`), with two gaps:

- **It does not write `session_index.jsonl`.** On this machine that file's last update is 2026-08-27; ids of later sessions are absent, so `thread_name` is always missing → the title falls back to the first `event_msg: user_message`, first line, truncated.
- **`token_count` reports only a total.** In `info.total_token_usage`, `input_tokens` / `output_tokens` / `cached_input_tokens` are all zero and the real number lives in `total_tokens`. `Usage` therefore carries an optional `totalTokens`; renderers prefer the in/out split and fall back to the total — **showing that zero as real output is not an option**, being the same class of mistake as a `—` that reads as zero cost (ADR-004).

### Cursor (M3)

```
~/Library/Application Support/Cursor/User/workspaceStorage/<workspace-hash>/state.vscdb
```

SQLite with an undocumented schema that changes between Cursor versions. No hook system, no event stream — **polling and diffing only**. Positioned as a **best-effort degraded adapter**: shows "this project is active" and promises nothing about state precision. Read via `sql.js` (WASM) to avoid a native module.

### Claude Desktop / Cowork (M3 — see ADR-007)

Cowork is **Claude Code running inside the desktop app**. Transcript format is identical to Claude Code's, so the parser is reused directly.

```
~/Library/Application Support/Claude/
  claude-code-sessions/<org>/<user>/local_<uuid>.json      ← 5 KB metadata sidecar per session
  local-agent-mode-sessions/<org>/<user>/local_<uuid>/
      .claude/projects/<encoded>/<uuid>.jsonl              ← identical to Claude Code format
      audit.jsonl                                          ← additional audit event stream
```

**The sidecar `local_<uuid>.json`** is very nearly a `Session` already:

| Field | Use |
|-------|-----|
| `sessionId` / `cliSessionId` | The latter points at the underlying Claude Code transcript |
| `cwd` / `originCwd` | Jump-to-terminal (though Cowork lives in the app — jump semantics need separate design) |
| `title` / `titleSource` | Title is ready-made (`titleSource: "auto"`) |
| `model` / `effort` / `permissionMode` | Display |
| `createdAt` / `lastActivityAt` / `lastFocusedAt` | Status and ordering |
| `isArchived` / `completedTurns` | Lifecycle |

**`audit.jsonl`'s `result` lines** provide `total_cost_usd`, `modelUsage`, `usage`, `stop_reason`, `num_turns`, `duration_ms`.

**Unverified:** whether the desktop app loads hooks from `~/.claude/settings.json`. If it doesn't, `liveEvents: false` and the adapter degrades to polling `lastActivityAt` and file mtimes for coarse status.

### Explicitly unsupported: pure chat products

**Re-checked 2026-09-09.** The conclusion holds, but the two products fail for different reasons — the earlier blanket "it's all server-side" was not accurate.

**ChatGPT desktop app — technically impossible.** Zero local conversation data. Verified across `~/Library/Application Support/com.openai.chat/` (only `app_pairing_extensions/`, a VS Code pairing record), `~/Library/Containers/`, `~/Library/Group Containers/2DC432GLL2.*`, and `~/Library/Caches/`. There is nothing to parse — not hard, just absent. The only routes are reading window text via the Accessibility API or calling OpenAI's backend, neither of which is local passive monitoring (ADR-002).

**Claude desktop app — technically possible, not worth it.** Conversations really are cached locally:

```
~/Library/Application Support/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/
  → object store "claude-conversation-store" (conversationUuid / title / messageCount / parent_message_uuid)
```

Reading it means solving three problems at once, any one of which outweighs every adapter written so far:

1. **LevelDB access.** Pure-JS implementations are not usable; `classic-level` is a native module, conflicting with the no-native-modules constraint (ADR-005 note).
2. **Blink SSV decoding.** IndexedDB values use Chromium's private binary serialization format, so the decoder would have to be written from scratch.
3. **The file is in use.** The app holds `LOCK` while running, forcing a directory snapshot before every read, and the format drifts with app versions — a large maintenance surface.

**The deciding factor is value, not cost.** Island exists because an agent runs in the background and you need to know when it needs you. Chat is synchronous — you are already looking at it, and there is no moment you need to be told about. Even at zero parsing cost it would not belong on the island.

**Two things that look like chat but are not, and are already supported:**

- **Codex Desktop** writes the same rollouts under `~/.codex/sessions/` (`session_meta.originator = "Codex Desktop"`); the existing Codex adapter **already covers it**. It writes no `session_index.jsonl`, so titles fall back to the first user message.
- **Claude Code running inside Claude Desktop** writes the same transcripts under `~/.claude/projects/`; the existing adapter **already covers it**. It produces no `ai-title` row — the title lives in the sidecar (see above).

---

## 6. Storage

In-memory for M1, behind an interface from the start:

```ts
interface SessionStore {
  upsert(s: Session): void
  get(id: string): Session | undefined
  list(filter?: { tool?: string; status?: Session['status'] }): Session[]
  recordEvent(e: SessionEvent): void
}
```

- **M1** — `MemoryStore`. Adapters `scan()` on startup to backfill, `watch()` for incremental updates.
- **M2** — `SqliteStore` (`node:sqlite`), plus the hook event log (ADR-008). Swapping touches one line. Trigger for landing it: the model has stabilized, and startup scans have gotten slow enough to hurt.

**Scan performance constraint:** This machine currently has 22 Claude Code sessions totalling 16 MB and 69 Codex sessions. Startup does **not** fully parse everything — sort by mtime and fully parse only the most recent N (default: last 7 days); older sessions come from index files or lazy loading.

**v1's SQL schema is void** (see ADR-005). M2 will design one from whatever `Session` / `SessionEvent` look like by then.

---

## 7. Internal Interfaces

After ADR-003 there is no cross-process HTTP API or SSE. Two interfaces remain:

### Hook receiver (the only HTTP surface)

```
POST http://127.0.0.1:7821/hook
{ "tool": "claude-code", "event": "PreToolUse", "sessionId": "...", "cwd": "...", "payload": {...} }
```

Constraints on the hook script:

- **2-second timeout, fail-open** — if Island isn't running, exit silently; never affect the agent
- Report-only, non-blocking in M1. M2's approval flow long-polls on a separate endpoint.

### Main → renderer (Electron IPC)

```ts
ipcMain → 'sessions:snapshot'   // full state, for first render
ipcMain → 'sessions:updated'    // incremental, single Session
ipcMain → 'sessions:removed'
```

---

## 8. UI Design

**Three display states:**

```
[Collapsed] Tray icon with a badge counting sessions needing attention

[Normal] Top-edge floating capsule
  ┌────────────────────────────────────────────┐
  │ ● claude-code  Refactor auth middleware 12m│
  │ ⏸ codex        Waiting: rm -rf ./dist      │
  │ ● cursor       FlowPilot active            │
  └────────────────────────────────────────────┘

[Expanded] Click a session
  ┌────────────────────────────────────────────┐
  │ claude-code · GildedRose updateQuality     │
  │ ~/ME/CMU/Courses/Refactoring/GildedRose    │
  │ $2.79 · 32k out · 12m41s                   │
  │                       [Jump to terminal]   │
  └────────────────────────────────────────────┘
```

- `always-on-top` + `frameless` + transparent background
- **Jump to terminal:** match on `cwd` and activate the corresponding Terminal / iTerm window or tab via AppleScript
- History drawer: completed sessions, today's usage grouped by tool and project

**M2 approval state:**

```
  ┌────────────────────────────────────────────┐
  │ codex wants to run:                        │
  │ $ rm -rf ./dist                            │
  │                      [Deny]      [Allow]   │
  └────────────────────────────────────────────┘
```

---

## 9. Tech Stack

| Layer | Technology |
|-------|-----------|
| Core (`src/core/`) | TypeScript, **zero Electron dependencies** — runnable under plain `node` |
| File watching | `chokidar`, incremental reads (track byte offset, parse only new bytes) |
| Storage | M1 in-memory · M2 `node:sqlite` (built in, no native module) |
| Reading Cursor's SQLite | `sql.js` (WASM), M2 |
| Desktop shell | Electron |
| Frontend | React + Tailwind CSS |
| Testing | Vitest + fixtures cut from real transcripts |
| Packaging | electron-builder → `.dmg` |
| Autostart | `app.setLoginItemSettings()` |

**Core principle:** `src/core/` never imports electron. The backend can therefore be developed and tested standalone — `npm run dev` starts a headless CLI that exercises the entire logic path.

---

## 10. Milestones

### M1 — Working backend (no UI)

- [x] Scaffold: TypeScript + tsx + Vitest, fixtures cut from real transcripts
- [x] `Session` / `SessionEvent` types + `SessionStore` interface + `MemoryStore`
- [x] `AgentAdapter` interface + capability declarations
- [x] Claude Code adapter: JSONL parsing → scan → incremental watch
- [x] Codex adapter: same (proves the abstraction is honest)
- [x] Hook receiver endpoint + shared relay script (idempotent merge install / uninstall)
- [x] Headless CLI `npm run dev`: live state stream printed to the terminal
- [ ] **Pending your verification**: install hooks, run real sessions, confirm running → waiting → complete

**Definition of done for M1:** Start a real Claude Code session and a real Codex session in other terminals; the CLI shows running → waiting → complete transitions live, with correct title, cwd, and usage.

### M2 — Electron UI

- [ ] Electron shell: frameless, always-on-top, system tray
- [ ] Capsule UI + expanded state (React + Tailwind)
- [ ] Jump to terminal (AppleScript)
- [ ] History drawer + usage stats
- [ ] Launch at login

### M3 — Feature complete

- [ ] Approve from the island (hook long-poll + fail-open timeout, see ADR-006)
- [ ] `SqliteStore` persistence
- [ ] Hook event log persisted alongside it (ADR-008)
- [ ] Claude Desktop (Cowork) adapter — reuse Claude Code parser + sidecar scanner
- [ ] Cursor adapter (degraded mode)

### M4 — Open source ready

- [ ] One-command install / uninstall (idempotent hook merge and surgical removal)
- [ ] Adapter authoring guide (how to onboard a new tool)
- [ ] README, demo recording
- [ ] `.dmg` release

---

## 11. Open Questions

| # | Question | Status |
|---|----------|--------|
| Q1 | ~~Include Claude Desktop (Cowork)?~~ | **Resolved 2026-09-02** — yes, in M2. See ADR-007 |
| Q5 | Does Cowork load hooks from `~/.claude/settings.json`? Determines its `liveEvents` capability | Verify before M3 |
| Q2 | Is `node:sqlite` available in Electron's bundled Node? | To verify before M2. Fallback: `sql.js` |
| Q3 | How does jump-to-terminal target a specific Terminal/iTerm tab? | Research before M2. Matching on cwd may be ambiguous |
| Q4 | Cursor's `state.vscdb` schema | Reverse-engineer before M3 |

---

## 12. Known Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Hook slots already occupied — `~/.claude/settings.json` has litmus; `~/.codex/hooks.json` has armorCodex + litmus; `~/.codex/config.toml`'s `notify` is a **single slot** already taken by Codex Computer Use | An overwriting installer breaks the user's existing tooling | Idempotent merge; tag our entries with `"_island": 1` (litmus uses `"_litmus": 1`); use Codex's `hooks.json`, never `notify`; uninstall removes only tagged entries |
| Transcript formats change with tool versions | Parse failures, missing fields | Tolerant parsers: skip unknown line types rather than throw; fixtures pin known formats; adapters report "format anomaly" instead of crashing |
| Cursor's reverse-engineered schema breaks on an upstream change | Cursor adapter stops working | Positioned as best-effort; on failure degrade to "Cursor detected but unreadable" without affecting other adapters |
| Hook scripts slow down every tool call | Agents feel sluggish | 2-second timeout, fail-open; M1 reports without blocking |

---

## 13. Out of Scope (V2+)

- Desktop pet / skins
- Custom sounds
- Windows / Linux support
- Cloud sync / team sharing
- Monitoring pure chat products (technically infeasible, see §5)
- Launching or supervising agent processes (see ADR-002)
