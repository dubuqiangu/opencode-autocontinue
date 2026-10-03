// Watch state for opencode-autocontinue.
// Persisted via ctx.storage (cross-restart); in-memory locks live only in this process.

import type { WatchState, WatchStatus } from "./rpc.ts"

export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

const STORAGE_KEY = "opencode-autocontinue.watched"

export interface InMemoryState {
  inFlight: boolean
  pendingContinue: boolean
  lastUserMessageAt: number
  lastBusyAt: number
}

export class WatchStore {
  private readonly watched = new Map<string, WatchState>()
  private readonly inMemory = new Map<string, InMemoryState>()
  private readonly storage: StorageLike

  constructor(storage: StorageLike) {
    this.storage = storage
  }

  /** Load persisted watch list. Call once at setup before any event handling. */
  async hydrate(): Promise<void> {
    try {
      const saved = (await this.storage.get(STORAGE_KEY)) as Record<string, WatchState> | undefined
      if (saved && typeof saved === "object") {
        for (const [sessionID, entry] of Object.entries(saved)) {
          if (entry && typeof entry.sessionID === "string") {
            this.watched.set(sessionID, { ...entry, sessionID })
          }
        }
      }
    } catch {
      // Storage unavailable �?run with empty list.
    }
  }

  private async persist(): Promise<void> {
    try {
      const snapshot: Record<string, WatchState> = {}
      for (const [sessionID, entry] of this.watched) snapshot[sessionID] = { ...entry }
      await this.storage.set(STORAGE_KEY, snapshot)
    } catch {
      // Non-fatal: memory keeps working for this process.
    }
  }

  isWatching(sessionID: string): boolean {
    return this.watched.has(sessionID)
  }

  getState(sessionID: string): WatchState | undefined {
    return this.watched.get(sessionID)
  }

  getMemory(sessionID: string): InMemoryState {
    let memory = this.inMemory.get(sessionID)
    if (!memory) {
      memory = { inFlight: false, pendingContinue: false, lastUserMessageAt: 0, lastBusyAt: 0 }
      this.inMemory.set(sessionID, memory)
    }
    return memory
  }

  /** Enable watching for a session. Resets counters. */
  async watch(sessionID: string, endAt = 0): Promise<WatchState> {
    const now = Date.now()
    const entry: WatchState = { sessionID, since: now, consecutive: 0, state: "watching", endAt }
    this.watched.set(sessionID, entry)
    this.inMemory.delete(sessionID)
    await this.persist()
    return entry
  }

  /** Disable watching for a session. */
  async unwatch(sessionID: string): Promise<void> {
    this.watched.delete(sessionID)
    this.inMemory.delete(sessionID)
    await this.persist()
  }

  /** Advance the consecutive counter and record injection time. */
  async recordInjection(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.consecutive += 1
    entry.lastInjectedAt = Date.now()
    await this.persist()
  }

  /** Mark the session done (completion marker seen) but keep it watched so the user sees "done". */
  async markDone(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "done"
    await this.persist()
  }

  /** Mark stopped (max consecutive / end time / explicit abort). */
  async markStopped(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "stopped"
    await this.persist()
  }

  /** Return to watching (e.g. user re-enables, or a fresh real user message). */
  async resume(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "watching"
    entry.consecutive = 0
    await this.persist()
  }

  /** Reset consecutive counter (real user message / successful progress). */
  async resetConsecutive(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.consecutive = 0
    await this.persist()
  }

  status(sessionID: string): { watched: boolean; state?: WatchStatus } {
    const entry = this.watched.get(sessionID)
    if (!entry) return { watched: false }
    return {
      watched: true,
      state: {
        sessionID: entry.sessionID,
        state: entry.state,
        consecutive: entry.consecutive,
        lastInjectedAt: entry.lastInjectedAt,
        since: entry.since,
      },
    }
  }

  list(): WatchStatus[] {
    return [...this.watched.values()].map((entry) => ({
      sessionID: entry.sessionID,
      state: entry.state,
      consecutive: entry.consecutive,
      lastInjectedAt: entry.lastInjectedAt,
        since: entry.since,
    }))
  }
}
