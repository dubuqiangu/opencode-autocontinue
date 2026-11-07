// Watch state for opencode-autocontinue.
// Persisted via ctx.storage (cross-restart); in-memory locks live only in this process.

import { STOP_REASONS, type StopReason, type WatchState, type WatchStatus } from "./rpc.ts"

export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

const STORAGE_KEY = "opencode-autocontinue.watched"

/** Why a watch round stopped. Persisted with the watch state so the UI can
 *  tell a guardrail stop apart from a window close or a user abort.
 *  The canonical list lives in `src/rpc.ts` (shared with the TUI); it is
 *  re-exported here so existing `src/state.ts` import paths keep working. */
export type { StopReason }
export { STOP_REASONS }

/** Whether a persisted value is one of the known stop reasons. */
export function isStopReason(value: unknown): value is StopReason {
  return typeof value === "string" && STOP_REASONS.includes(value as StopReason)
}

export interface InMemoryState {
  inFlight: boolean
  /** True when a real user message expressed dissatisfaction with the quality;
   *  the frustration clause is then appended to the next injection. */
  frustrationPending: boolean
  pendingContinue: boolean
  /** Epoch ms when pendingContinue was set (staleness check for the latch). */
  pendingContinueAt: number
  lastUserMessageAt: number
  lastBusyAt: number
  /** Epoch ms of the most recent "session actively running/streaming" signal
   *  (execution started, step started/streamed, or busy status). Injection is
   *  gated until this settles, so a still-running session is never poked. */
  lastActiveAt: number
  /** Last continuation this plugin injected, for the host-agnostic self-echo
   *  guard: a matching inbound "user" message is our own injection returning,
   *  not a real user turn. */
  lastSelfInjection?: { text: string; at: number }
  /** Aborts a still-running verification command (off / dispose / new round). */
  activeVerifyAbort?: AbortController
  /** True while this session's verification command is in flight (drives the
   *  "verifying" indicator in the TUI). */
  verifying: boolean
  /** Opt-in tool-failure observation counter (does NOT affect completion). */
  toolFailureCount: number
  /** Rolling window of distinct failed tool ids, so a retried failure is not
   *  double-counted (capped at the last 128 ids). */
  toolFailureIds: string[]
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
        const now = Date.now()
        for (const [sessionID, entry] of Object.entries(saved)) {
          if (!entry || typeof entry.sessionID !== "string") continue
          // Terminal rows (done/stopped) are round-end feedback for the
          // session that just ran — not a watch to resume. Restoring them
          // across restarts made every previously watched session report
          // watched=true forever, which kept the sidebar "Watch" block on
          // screen by default. Drop them on hydrate; the next persist()
          // rewrites storage without them. A paused row IS preserved: it is an
          // active watch waiting on user input.
          if (entry.state === "done" || entry.state === "stopped") continue
          // Normalize legacy rows: old persisted data may lack since/injections
          // or carry null lastInjectedAt, which would fail the RPC schema
          // validator (status/list output must not contain undefined/null).
          // Legacy `consecutive`+`heartbeats` are folded into a single `injections`.
          const legacyConsecutive = (entry as { consecutive?: unknown }).consecutive
          const legacyHeartbeats = (entry as { heartbeats?: unknown }).heartbeats
          const legacyTotal =
            (typeof legacyConsecutive === "number" ? legacyConsecutive : 0) +
            (typeof legacyHeartbeats === "number" ? legacyHeartbeats : 0)
          const normalizedSince = typeof entry.since === "number" ? entry.since : now
          this.watched.set(sessionID, {
            sessionID,
            state: entry.state === "paused" ? "paused" : "watching",
            injections: typeof entry.injections === "number" ? entry.injections : legacyTotal,
            totalInjections: typeof entry.totalInjections === "number" ? entry.totalInjections : legacyTotal,
            since: normalizedSince,
            // Rows persisted by v0.5.2 and earlier carry no roundSince: fall
            // back to the row's `since` (which itself falls back to `now` when
            // missing), so a legacy watch does not silently get a fresh,
            // full-length wall-clock budget.
            roundSince: typeof entry.roundSince === "number" ? entry.roundSince : normalizedSince,
            endAt: typeof entry.endAt === "number" ? entry.endAt : 0,
            // B-5: the field-by-field rebuild below would otherwise drop these
            // (or carry NaN from a legacy row), so normalize each explicitly.
            rejections: typeof entry.rejections === "number" ? entry.rejections : 0,
            roundId: typeof entry.roundId === "number" ? entry.roundId : 0,
            ...(typeof entry.lastInjectedAt === "number" ? { lastInjectedAt: entry.lastInjectedAt } : {}),
            // A stop reason only survives when it is one of the known values.
            ...(isStopReason(entry.stopReason) ? { stopReason: entry.stopReason } : {}),
          })
        }
      }
    } catch {
      // Storage unavailable — run with empty list.
    }
  }

  private persistChain: Promise<void> = Promise.resolve()
  private async persist(): Promise<void> {
    const snapshot: Record<string, WatchState> = {}
    for (const [sessionID, entry] of this.watched) snapshot[sessionID] = { ...entry }
    // Serialize writes so a slow earlier persist can't overwrite a newer
    // snapshot built from later state (lost update across concurrent calls).
    this.persistChain = this.persistChain.then(async () => {
      try {
        await this.storage.set(STORAGE_KEY, snapshot)
      } catch {
        // Non-fatal: memory keeps working for this process.
      }
    })
    return this.persistChain
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
      memory = {
        inFlight: false,
        frustrationPending: false,
        pendingContinue: false,
        pendingContinueAt: 0,
        lastUserMessageAt: 0,
        lastBusyAt: 0,
        lastActiveAt: 0,
        verifying: false,
        toolFailureCount: 0,
        toolFailureIds: [],
      }
      this.inMemory.set(sessionID, memory)
    }
    return memory
  }

  /** Enable watching for a session. Resets counters. */
  async watch(sessionID: string, endAt = 0): Promise<WatchState> {
    const now = Date.now()
    const entry: WatchState = {
      sessionID,
      since: now,
      // A fresh watch also starts the first round's wall-clock budget.
      roundSince: now,
      injections: 0,
      totalInjections: 0,
      rejections: 0,
      // A fresh watch initializes the round id; resume() bumps it (see below).
      roundId: 0,
      state: "watching",
      endAt,
    }
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

  /** Advance the injection counter and record injection time. */
  async recordInjection(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.injections += 1
    entry.totalInjections += 1
    entry.lastInjectedAt = Date.now()
    await this.persist()
  }

  /** Count one failing verification round (verify-driven loop). */
  async recordRejection(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.rejections += 1
    await this.persist()
  }

  /** Mark the session done (final completion marker seen) but keep it watched so the user sees "done". */
  async markDone(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "done"
    // A finished round carries no stop reason (a previous round's reason must
    // not leak into the "done" status).
    entry.stopReason = undefined
    await this.persist()
  }

  /** Mark stopped (max injections / end time / watch timeout / explicit abort).
   *  The optional reason records WHY the round stopped; calling without one
   *  clears any previously stored reason. */
  async markStopped(sessionID: string, reason?: StopReason): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "stopped"
    entry.stopReason = reason
    await this.persist()
  }

  /** Pause the watch after a model pause sentinel: waiting on the user, no
   *  injection until a real user turn flips it back to watching (resume()). */
  async markPaused(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "paused"
    await this.persist()
  }

  /** Move a session into the final-check phase after its first completion marker.
   *  The watch round continues; a second marker (after the review injection)
   *  will mark it done. */
  async beginConfirming(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "confirming"
    await this.persist()
  }

  /** Return to watching after a review round that carried no completion marker.
   *  Keeps the injection counter (same watch round) — unlike resume(), which
   *  resets counters for a fresh user turn. */
  async continueWatching(sessionID: string): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "watching"
    await this.persist()
  }

  /** Return to watching (e.g. user re-enables, or a fresh real user message).
   *  `preserveRejections` keeps the failure counter when the user message was
   *  itself a complaint (the previous delivery was rejected), while the round
   *  id still advances so an in-flight verification result is discarded. */
  async resume(
    sessionID: string,
    recomputeEndAt = false,
    preserveRejections = false,
  ): Promise<void> {
    const entry = this.watched.get(sessionID)
    if (!entry) return
    entry.state = "watching"
    entry.injections = 0
    // A new round has no stop reason yet — the previous round's reason must
    // not leak into the resumed status.
    entry.stopReason = undefined
    // A real user message starts a new round: its failures reset, and the round
    // id advances so a verification result from the previous round is discarded.
    // A complaint about the delivered quality is itself evidence that the last
    // round was rejected, so that counter is preserved.
    if (!preserveRejections) entry.rejections = 0
    entry.roundId += 1
    // The wall-clock watch budget is measured per round: a new round starts a
    // fresh budget instead of inheriting the previous round's remainder.
    // `since` is deliberately NOT touched — it marks the start of the whole
    // watch and drives the sidebar timer.
    entry.roundSince = Date.now()
    // 用户新消息代表新一轮对话：清掉 pendingContinue 闩锁（错误已解决）。
    // 但保留 lastUserMessageAt——宽限期判定仍依赖它，整删内存会破坏 userGraceMs。
    const memory = this.inMemory.get(sessionID)
    if (memory) {
      memory.pendingContinue = false
      memory.pendingContinueAt = 0
    }
    // P2-10: 若值守窗口已过（endAt 过去），resume 不应把它翻回 watching 后又被
    // 下一次 idle 打回 stopped（反复翻转）。调用方传 recomputeEndAt=true 时，仅
    // 在窗口已过的情况下把 endAt 置 0 —— 即关闭当日截止（0 = 无每日截止），本轮
    // 余下时间不再受 endAt 限制；这里并不重算 endAt。
    if (recomputeEndAt && entry.endAt && Date.now() >= entry.endAt) {
      entry.endAt = 0
    }
    await this.persist()
  }

  /** True while this session's verification command is in flight. */
  isVerifying(sessionID: string): boolean {
    return this.inMemory.get(sessionID)?.verifying ?? false
  }

  /** Observe one tool outcome for the opt-in failure counter (observation only,
   *  never affects completion/stop). Deduplicated over a rolling window of the
   *  last 128 distinct failed ids; a terminal success resets the count without
   *  clearing the window (so a retried failure is not double-counted). */
  observeToolOutcome(sessionID: string, id: string | undefined, errored: boolean): void {
    const memory = this.getMemory(sessionID)
    if (errored) {
      // A failure without a stable id cannot be deduplicated — skip it rather
      // than inflating the count on every scan.
      if (!id) return
      if (memory.toolFailureIds.includes(id)) return
      memory.toolFailureCount = Math.min(memory.toolFailureCount + 1, 1_000_000)
      memory.toolFailureIds.push(id)
      memory.toolFailureIds = memory.toolFailureIds.slice(-128)
      return
    }
    // Terminal success clears the count but keeps the window (防同 id 重计).
    memory.toolFailureCount = 0
  }

  status(sessionID: string): { watched: boolean; state?: WatchStatus } {
    const entry = this.watched.get(sessionID)
    if (!entry) return { watched: false }
    const memory = this.inMemory.get(sessionID)
    return {
      watched: true,
      state: {
        sessionID: entry.sessionID,
        state: entry.state,
        injections: entry.injections,
        totalInjections: entry.totalInjections,
        // Omit lastInjectedAt when never injected: the runtime schema
        // validator rejects undefined against {type:"number"}.
        ...(entry.lastInjectedAt !== undefined ? { lastInjectedAt: entry.lastInjectedAt } : {}),
        since: entry.since,
        rejections: entry.rejections,
        verifying: memory?.verifying ?? false,
        toolFailureCount: memory?.toolFailureCount ?? 0,
        // Only present while the round carries a stop reason.
        ...(entry.stopReason !== undefined ? { stopReason: entry.stopReason } : {}),
      },
    }
  }

  list(): WatchStatus[] {
    return [...this.watched.values()].map((entry) => ({
      sessionID: entry.sessionID,
      state: entry.state,
      injections: entry.injections,
      totalInjections: entry.totalInjections,
      ...(entry.lastInjectedAt !== undefined ? { lastInjectedAt: entry.lastInjectedAt } : {}),
      since: entry.since,
      rejections: entry.rejections,
      verifying: this.inMemory.get(entry.sessionID)?.verifying ?? false,
      toolFailureCount: this.inMemory.get(entry.sessionID)?.toolFailureCount ?? 0,
      // Only present while the round carries a stop reason.
      ...(entry.stopReason !== undefined ? { stopReason: entry.stopReason } : {}),
    }))
  }
}
