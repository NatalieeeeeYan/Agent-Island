import { screen, type BrowserWindow, type Rectangle } from 'electron'

import type { Session } from '../core/types.js'
import { CH, type IslandView } from '../shared/ipc.js'

// The notch width is not exposed by the OS; this is a tunable estimate for the
// gap the camera punches through the collapsed bar. Adjust per MacBook model.
const NOTCH_WIDTH = 200
// A narrow wing on each side of the notch — just enough for a dot and a count.
// The bar hugs the notch rather than spreading across the menu bar.
const WING_WIDTH = 28
const COLLAPSED_WIDTH = NOTCH_WIDTH + WING_WIDTH * 2

const EXPANDED_WIDTH = 680
const EXPANDED_HEIGHT = 320

// How long an auto-triggered panel stays open before tucking itself away.
const AUTO_COLLAPSE_MS = 6000

/** Top-center bounds for either notch state, anchored to the primary display. */
export function notchBounds(mode: IslandView['mode']): Rectangle {
  const display = screen.getPrimaryDisplay()
  const b = display.bounds
  // workArea excludes the menu bar; its top offset is the menu-bar/notch band.
  const bandHeight = Math.max(display.workArea.y - b.y, 24)
  const centerX = Math.round(b.x + b.width / 2)

  if (mode === 'collapsed') {
    return {
      x: centerX - Math.round(COLLAPSED_WIDTH / 2),
      y: b.y,
      width: COLLAPSED_WIDTH,
      height: bandHeight,
    }
  }
  return {
    x: centerX - Math.round(EXPANDED_WIDTH / 2),
    y: b.y,
    width: EXPANDED_WIDTH,
    height: EXPANDED_HEIGHT,
  }
}

export type NotchController = {
  /** Set the initial collapsed bounds and paint, without animating. */
  init(): void
  expand(focus: Session | null, auto: boolean): void
  /** Cancel a pending auto-collapse (pointer entered the panel). */
  hold(): void
  collapse(): void
}

export function createNotchController(win: BrowserWindow): NotchController {
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function paint(view: IslandView): void {
    win.webContents.send(CH.view, view)
  }

  function expand(focus: Session | null, auto: boolean): void {
    clearTimer()
    win.setBounds(notchBounds('expanded'), true)
    paint({ mode: 'expanded', focus })
    if (auto) timer = setTimeout(collapse, AUTO_COLLAPSE_MS)
  }

  function collapse(): void {
    clearTimer()
    win.setBounds(notchBounds('collapsed'), true)
    paint({ mode: 'collapsed', focus: null })
  }

  return {
    init(): void {
      win.setBounds(notchBounds('collapsed'))
      paint({ mode: 'collapsed', focus: null })
    },
    expand,
    hold: clearTimer,
    collapse,
  }
}
