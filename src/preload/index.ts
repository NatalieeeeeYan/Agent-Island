import { contextBridge, ipcRenderer } from 'electron'

import { CH, type IslandView } from '../shared/ipc.js'
import type { Session, SessionEvent } from '../core/types.js'

const api = {
  snapshot(): Promise<Session[]> {
    return ipcRenderer.invoke(CH.snapshot)
  },
  subscribe(listener: (event: SessionEvent) => void): () => void {
    const handler = (_: unknown, event: SessionEvent): void => listener(event)
    ipcRenderer.on(CH.event, handler)
    return () => ipcRenderer.off(CH.event, handler)
  },
  onView(listener: (view: IslandView) => void): () => void {
    const handler = (_: unknown, view: IslandView): void => listener(view)
    ipcRenderer.on(CH.view, handler)
    return () => ipcRenderer.off(CH.view, handler)
  },
  expand(): void {
    ipcRenderer.send(CH.expand)
  },
  hold(): void {
    ipcRenderer.send(CH.hold)
  },
  collapse(): void {
    ipcRenderer.send(CH.collapse)
  },
}

export type IslandApi = typeof api

contextBridge.exposeInMainWorld('island', api)
