# Agent Island

Unified monitor for the AI coding agents running on your machine — who's working, who's waiting on you, what each has spent.

**Status: M1 (backend) complete.** No UI yet; the backend runs headless and prints to the terminal.

See [the design spec](docs/superpowers/specs/2026-06-21-agent-island-design-zh.md) ([English](docs/superpowers/specs/2026-06-21-agent-island-design.md)) for architecture and the decision log.

## Run it

```bash
npm install
npm run dev
```

```
Agent Island — headless
  adapters : Claude Code, Codex
  hooks    : http://127.0.0.1:7821/hook
  scanned  : 20 sessions (last 7d)

  ● claude-code Agent island design 后端      ~/ME/Projects/Agent_Island   203.4k out
  ○ claude-code GildedRose updateQuality      ~/ME/CMU/…/GildedRoseKata     31.8k out $2.80
  ✗ codex       如何能修一下？                  ~/Documents/Codex/…/zhe-ge

watching… (ctrl-c to stop)
```

Start a real Claude Code or Codex session in another terminal and the transitions appear live.

## Commands while it runs

On a TTY the same process also takes commands. The live stream keeps printing
around the prompt.

```
> ls waiting
(none)

> fire 94d92866 Notification Bash
23:31:03   ⏸ claude-code 实现进度检查   ~/ME/Projects/Agent_Island  200.5k out
posted Notification for 94d92866

> show 94d92866
id       94d92866-a22c-432c-b957-6f07b4fb3b48
status   waiting
waiting  Bash since 23:31:03
usage    202.4k out
source   ~/.claude/projects/…/94d92866-….jsonl
```

| Command | Purpose |
|---------|---------|
| `ls [status\|tool]` | List sessions, newest first |
| `show <id-prefix>` | Everything known about one session, including its latest reply |
| `fire <id-prefix> <Event> [toolName]` | Post a synthetic hook event |
| `help` / `quit` | |

`fire` exists because `waiting` and `complete` come only from hooks, so without
it you cannot see those states without provoking a real approval prompt. It
posts to the hook endpoint over HTTP rather than reaching into the store, so a
test exercises the same path a real hook takes. The session is resolved locally
first — the endpoint answers `204` by contract, so an unknown id would otherwise
be a silent no-op.

Ids are printed at the shortest prefix that is unambiguous, which is longer for
Codex: its UUIDv7 ids begin with a timestamp, so same-day sessions share their
leading characters.

Piped or redirected output (`npm run dev > log`) skips the prompt entirely and
behaves as a plain log.

**There is deliberately no `tsx watch` variant.** Watch mode binds the Return
key to "restart the process", so under it a command can never be submitted —
every Enter reloads the app instead. Restart by hand after editing.

## Hooks

Transcripts alone say what an agent did, not whether it is *blocked on you* — a
pause in the file looks the same either way. Hooks fill that gap.

```bash
npm run hooks:dry        # show what would change
npm run hooks:install    # merge Island's entries into the tools' settings
npm run hooks:uninstall  # remove only Island's entries
```

This edits `~/.claude/settings.json` and `~/.codex/hooks.json`, both of which
usually already contain other tools' hooks. Installation **merges** — every group
Island owns is tagged `"_island": 1`, existing entries are untouched, re-running
is a no-op, and uninstall removes only tagged groups. The previous file is copied
to `<path>.island-backup` before any write.

The relay script (`hooks/island-hook.mjs`) runs on every tool call of every
session, so it is built to be incapable of affecting an agent: 2-second timeout,
silent on stdout, and always exits 0 — if Island isn't running the hook is a
no-op.

## Layout

```
src/core/            zero Electron dependencies — runs under plain node
  types.ts             Session, AgentAdapter, capability declarations
  island.ts            orchestration; folds hook events into session status
  store.ts             SessionStore interface + MemoryStore
  status.ts            what status a transcript alone can honestly support
  jsonl.ts             incremental JSONL reader (byte-offset cursor)
  claude-desktop-sidecar.ts  titles for sessions launched from Claude Desktop
  hook-server.ts       loopback receiver on 127.0.0.1:7821
  hook-install.ts      idempotent merge into the tools' settings files
  parsers/             per-tool transcript folding, pure functions
  adapters/            per-tool scan + watch
src/cli/
  dev.ts               headless entry point; wires the terminal to the REPL
  repl.ts              command dispatch — strings in, strings out, no TTY
  format.ts            rendering shared by the live stream and the commands
hooks/               the relay script installed into the tools
tests/fixtures/      slices of real transcripts from this machine
```

## Design notes

**Capabilities are declared, not assumed.** Each adapter states whether it has a
transcript, live events, usage data, and approval interception. The UI branches
on these — a tool that reports no cost shows no cost field, not a `—` that reads
as zero. Codex, for instance, reports tokens but no dollar amount.

**Only recent sessions, and only their opening lines.** A session stays listed
while it has been active in the last 24 hours; `SessionEnd` drops it at once.
Every text folded out of a transcript is clipped to 200 characters at parse
time, because one row can hold a whole pasted file while only its opening is
ever shown. An evicted session is rebuilt in full the next time its transcript
changes — idle costs nothing, waking up pays one re-parse. See ADR-009.

**Status is only as precise as the evidence.** A transcript supports `running`
and `idle`; `waiting` and `complete` come from hooks; `error` comes from an
explicit failure record in the transcript. Nothing is inferred beyond that.

**Two adapters, not one.** Claude Code and Codex are structurally similar but
schema-different, which is the minimum sample size for an honest abstraction —
designing it from a single example is how you get an interface shaped like one
tool's implementation.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Headless backend with the live stream and commands (`npm start` is the same) |
| `npm test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run hooks:dry` | Preview hook installation |
| `npm run hooks:install` | Install hooks |
| `npm run hooks:uninstall` | Remove hooks |

Requires Node 22+ and macOS.
# Agent-Island
