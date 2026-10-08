import type { Session, SessionEvent } from '../core/types'
import type { IslandView } from '../shared/ipc'

declare global {
  interface Window {
    island: {
      snapshot(): Promise<Session[]>
      subscribe(listener: (event: SessionEvent) => void): () => void
      onView(listener: (view: IslandView) => void): () => void
      expand(): void
      hold(): void
      collapse(): void
    }
  }
}

export {}
