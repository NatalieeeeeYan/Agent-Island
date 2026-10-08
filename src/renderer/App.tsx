import { useEffect, useMemo, useRef, useState } from 'react'

import type { Session, SessionEvent, SessionStatus } from '../core/types.js'
import type { IslandView } from '../shared/ipc.js'

const MARK: Record<SessionStatus, string> = {
  running: '●',
  waiting: '⏸',
  idle: '○',
  complete: '✓',
  error: '✗',
}

const MARK_COLOR: Record<SessionStatus, string> = {
  running: 'text-emerald-400',
  waiting: 'text-amber-400',
  idle: 'text-zinc-500',
  complete: 'text-sky-400',
  error: 'text-rose-400',
}

// waiting first (it needs the user), then running, then the rest
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0,
  running: 1,
  idle: 2,
  error: 3,
  complete: 4,
}

function usageText(session: Session): string | null {
  const u = session.usage
  if (!u) return null
  const out = u.outputTokens || u.totalTokens
  const parts: string[] = []
  if (out) parts.push(`${(out / 1000).toFixed(out >= 10_000 ? 0 : 1)}k out`)
  if (u.costUSD) parts.push(`$${u.costUSD.toFixed(2)}`)
  return parts.join(' · ') || null
}

function primaryText(session: Session): string {
  if (session.status === 'waiting' && session.waitingOn) {
    return `等待: ${session.waitingOn.summary}`
  }
  return session.title ?? session.lastReply ?? '(未命名)'
}

function shortCwd(cwd: string): string {
  const home = cwd.replace(/^\/Users\/[^/]+/, '~')
  const parts = home.split('/').filter(Boolean)
  return parts.length <= 2 ? home : `…/${parts.slice(-2).join('/')}`
}

function Row({ session }: { session: Session }): React.JSX.Element {
  const usage = usageText(session)
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[13px] leading-tight">
      <span className={`${MARK_COLOR[session.status]} w-3 shrink-0 text-center`}>
        {MARK[session.status]}
      </span>
      <span className="w-20 shrink-0 truncate text-zinc-500">{session.tool}</span>
      <span className="flex-1 truncate text-zinc-100">{primaryText(session)}</span>
      {usage && <span className="shrink-0 tabular-nums text-zinc-500">{usage}</span>}
    </div>
  )
}

function FocusCard({ session }: { session: Session }): React.JSX.Element {
  const usage = usageText(session)
  return (
    <div className="border-b border-white/10 px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className={`${MARK_COLOR[session.status]} text-sm`}>{MARK[session.status]}</span>
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">{session.tool}</span>
        {usage && <span className="ml-auto text-[12px] tabular-nums text-zinc-400">{usage}</span>}
      </div>
      <div className="mt-1 truncate text-[15px] font-medium text-zinc-50">
        {primaryText(session)}
      </div>
      <div className="mt-0.5 truncate text-[12px] text-zinc-500">{shortCwd(session.cwd)}</div>
      {session.lastReply && (
        <div className="mt-2 line-clamp-2 text-[12px] leading-snug text-zinc-400">
          {session.lastReply}
        </div>
      )}
    </div>
  )
}

/**
 * Collapsed state: one semi-transparent bar centered on the notch. The camera
 * punches a gap through its middle, so content lives in the two wings — status
 * counts on the left, the headline on the right.
 */
function Pill({
  running,
  waiting,
  total,
}: {
  running: number
  waiting: number
  total: number
}): React.JSX.Element {
  const dot = waiting > 0 ? 'bg-amber-400' : running > 0 ? 'bg-emerald-400' : 'bg-zinc-400/70'
  const count = waiting > 0 ? 'text-amber-300' : 'text-zinc-300'
  return (
    <button
      type="button"
      onClick={() => window.island.expand()}
      className="flex h-full w-full cursor-default items-stretch"
    >
      <div className="flex h-full w-full items-center justify-between rounded-md bg-black/45 px-2 ring-1 ring-white/10 backdrop-blur">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className={`text-[11px] font-medium leading-none tabular-nums ${count}`}>
          {waiting > 0 ? waiting : total}
        </span>
      </div>
    </button>
  )
}

export function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map())
  const [view, setView] = useState<IslandView>({ mode: 'collapsed', focus: null })
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let live = true

    void window.island.snapshot().then((list) => {
      if (live) setSessions(new Map(list.map((s) => [s.id, s])))
    })

    const offEvent = window.island.subscribe((event: SessionEvent) => {
      setSessions((prev) => {
        const next = new Map(prev)
        switch (event.kind) {
          case 'session_started':
          case 'session_updated':
            next.set(event.session.id, event.session)
            break
          case 'session_removed':
            next.delete(event.sessionId)
            break
          case 'adapter_error':
            break
        }
        return next
      })
    })

    const offView = window.island.onView(setView)

    return () => {
      live = false
      offEvent()
      offView()
    }
  }, [])

  const rows = useMemo(() => {
    return [...sessions.values()].sort((a, b) => {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
      return rank !== 0 ? rank : b.updatedAt - a.updatedAt
    })
  }, [sessions])

  const waiting = useMemo(() => rows.filter((s) => s.status === 'waiting').length, [rows])
  const running = useMemo(() => rows.filter((s) => s.status === 'running').length, [rows])

  if (view.mode === 'collapsed') {
    return (
      <div className="h-full w-full bg-transparent">
        <Pill running={running} waiting={waiting} total={rows.length} />
      </div>
    )
  }

  const onEnter = (): void => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    window.island.hold()
  }
  const onLeave = (): void => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => window.island.collapse(), 1200)
  }

  return (
    <div className="flex h-full w-full items-start justify-center bg-transparent">
      <div
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className="flex max-h-full w-full flex-col overflow-hidden rounded-b-2xl border border-t-0 border-white/10 bg-zinc-900/90 text-zinc-100 shadow-2xl backdrop-blur-xl"
      >
        <div className="flex items-center justify-between px-4 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
          <span>Agent Island</span>
          <div className="flex items-center gap-2">
            <span className="tabular-nums">{rows.length}</span>
            <button
              type="button"
              onClick={() => window.island.collapse()}
              className="h-2.5 w-2.5 rounded-full bg-zinc-600 hover:bg-rose-400"
              aria-label="收起"
            />
          </div>
        </div>

        {view.focus && <FocusCard session={view.focus} />}

        <div className="flex-1 overflow-y-auto py-1">
          {rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-zinc-600">暂无会话</div>
          ) : (
            rows.map((session) => <Row key={session.id} session={session} />)
          )}
        </div>
      </div>
    </div>
  )
}
