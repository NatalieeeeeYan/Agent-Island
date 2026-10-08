import { join } from 'node:path'

import { app, BrowserWindow, ipcMain } from 'electron'

import { ClaudeCodeAdapter } from '../core/adapters/claude-code.js'
import { CodexAdapter } from '../core/adapters/codex.js'
import { createIsland, DEFAULT_RETENTION_MS } from '../core/island.js'
import type { SessionStatus } from '../core/types.js'
import { CH } from '../shared/ipc.js'
import { createNotchController, notchBounds } from './notch.js'

const island = createIsland({
  adapters: [new ClaudeCodeAdapter(), new CodexAdapter()],
  scan: { since: Date.now() - DEFAULT_RETENTION_MS, limit: 50 },
})

// States worth interrupting for: the agent stopped, is blocked, or errored.
const ATTENTION: ReadonlySet<SessionStatus> = new Set(['waiting', 'idle', 'error'])

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...notchBounds('collapsed'),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // macOS otherwise clamps the window frame below the menu bar; this lifts
    // that constraint so it can sit at y=0 over the notch band.
    enableLargerThanScreen: true,
    // A HUD must never steal key focus from whatever the user is doing.
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      backgroundThrottling: false,
    },
  })

  // Float above the menu bar and follow the user across spaces / fullscreen.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  return win
}

app.whenReady().then(async () => {
  const win = createWindow()
  const notch = createNotchController(win)

  win.webContents.on('did-finish-load', () => notch.init())

  ipcMain.handle(CH.snapshot, () => island.store.list())
  ipcMain.on(CH.expand, () => notch.expand(null, false))
  ipcMain.on(CH.hold, () => notch.hold())
  ipcMain.on(CH.collapse, () => notch.collapse())

  // Only a real transition into an attention state pops the panel — a session
  // already idle when the startup scan finds it has no previous status, so the
  // island stays tucked away until something actually happens.
  const lastStatus = new Map<string, SessionStatus>()

  island.subscribe((event) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(CH.event, event)

    if (event.kind === 'session_started' || event.kind === 'session_updated') {
      const { id, status } = event.session
      const previous = lastStatus.get(id)
      lastStatus.set(id, status)
      if (previous && previous !== status && ATTENTION.has(status)) {
        notch.expand(event.session, true)
      }
    } else if (event.kind === 'session_removed') {
      lastStatus.delete(event.sessionId)
    }
  })

  try {
    await island.start()
  } catch (error) {
    // Port already bound means another Island owns the hook socket. The disk
    // scan has already populated the store and the file watchers are live, so
    // the island still renders — only real-time hook transitions are lost.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    console.warn('hook port busy — running without live hook events')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void island.stop().finally(() => app.quit())
})
