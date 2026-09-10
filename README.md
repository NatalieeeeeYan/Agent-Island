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
src/cli/dev.ts       headless entry point
hooks/               the relay script installed into the tools
tests/fixtures/      slices of real transcripts from this machine
```

## Design notes

**Capabilities are declared, not assumed.** Each adapter states whether it has a
transcript, live events, usage data, and approval interception. The UI branches
on these — a tool that reports no cost shows no cost field, not a `—` that reads
as zero. Codex, for instance, reports tokens but no dollar amount.

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
| `npm run dev` | Headless backend with live output (watch mode) |
| `npm test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run hooks:dry` | Preview hook installation |
| `npm run hooks:install` | Install hooks |
| `npm run hooks:uninstall` | Remove hooks |

Requires Node 22+ and macOS.
# Agent-Island
