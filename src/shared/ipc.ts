import type { Session } from '../core/types.js'

// IPC channel names shared by the Electron main process and the preload bridge
export const CH = {
  // invoke: renderer asks main for the current session list
  snapshot: 'island:snapshot',
  // send: main pushes a SessionEvent to every renderer
  event: 'island:event',
  // send: main tells the renderer which notch state to paint
  view: 'island:view',
  // send: renderer asks main to drop the panel open (user clicked the pill)
  expand: 'island:expand',
  // send: renderer asks main to cancel the auto-collapse timer (pointer is over the panel)
  hold: 'island:hold',
  // send: renderer asks main to tuck the panel back to the notch
  collapse: 'island:collapse',
} as const

/** What the notch is showing. `focus` is the session that triggered an auto-expand. */
export type IslandView = {
  mode: 'collapsed' | 'expanded'
  focus: Session | null
}
