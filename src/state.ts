// Watch state for opencode-autocontinue.
// Persisted via ctx.storage (cross-restart); in-memory locks live only in this process.

import { STOP_REASONS, type StopReason, type WatchState, type WatchStatus } from "./rpc.ts"

export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

const STORAGE_KEY = "opencode-autocontinue.watched"

/** Process-wide monotonic round counter. Every watch()/resume() takes a fresh
 *  number from here, so round ids are globally unique and strictly increasing
 *  — a stale verification result can never be mistaken for the current round
 *  (an "off -> on" switch used to reset the id to 0).
 *
 *  The counter is a static class member rather than an instance field: two
 *  WatchStore instances in the same process (a restart inside one host, or a
 *  test creating a second store) must never hand out the same id, otherwise a
 *  verification result captured under one store could be accepted by the
 *  other. */
let processRoundIdCounter = 0

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

/** Cross-round operation state of a watched session. It is deliberately NOT
 *  reset when a new watch round starts: the in-flight injection lock belongs
 *  to the injection lifecycle, not to the round. Dropping it would let a
 *  second trigger inject a second time while the first injection is still
 *  running. */
export interface SessionLock {
  /** True while an injection is in flight for this session. */
  inFlight: boolean
  /** Aborts a still-running verification command (off / dispose / new round). */
  activeVerifyAbort?: AbortController
  /** True while this session's verification command is in flight (drives the
   *  "verifying" indicator in the TUI). */
  verifying: boolean
}

/** Per-round cache of a watched session. A new watch round resets it. */
export interface RoundCache {
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
  /** Opt-in tool-failure observation counter (does NOT affect completion). */
  toolFailureCount: number
  /** Rolling window of distinct failed tool ids, so a retried failure is not
   *  double-counted (capped at the last 128 ids). */
  toolFailureIds: string[]
}

/** Merged view over a session's lock and round cache. */
export interface InMemoryState extends SessionLock, RoundCache {}

/** Live view over one session's lock and round cache. Every field write goes
 *  straight to the underlying record, so `getMemory()` stays a drop-in
 *  replacement for the previous single-object API. */
class SessionMemoryView implements InMemoryState {
  readonly lock: SessionLock
  readonly round: RoundCache

  constructor(lock: SessionLock, round: RoundCache) {
    this.lock = lock
    this.round = round
  }

  get inFlight(): boolean {
    return this.lock.inFlight
  }
  set inFlight(value: boolean) {
    this.lock.inFlight = value
  }

  get activeVerifyAbort(): AbortController | undefined {
    return this.lock.activeVerifyAbort
  }
  set activeVerifyAbort(value: AbortController | undefined) {
    this.lock.activeVerifyAbort = value
  }

  get verifying(): boolean {
    return this.lock.verifying
  }
  set verifying(value: boolean) {
    this.lock.verifying = value
  }

  get frustrationPending(): boolean {
    return this.round.frustrationPending
  }
  set frustrationPending(value: boolean) {
    this.round.frustrationPending = value
  }

  get pendingContinue(): boolean {
    return this.round.pendingContinue
  }
  set pendingContinue(value: boolean) {
    this.round.pendingContinue = value
  }

  get pendingContinueAt(): number {
    return this.round.pendingContinueAt
  }
  set pendingContinueAt(value: number) {
    this.round.pendingContinueAt = value
  }

  get lastUserMessageAt(): number {
    return this.round.lastUserMessageAt
  }
  set lastUserMessageAt(value: number) {
    this.round.lastUserMessageAt = value
  }

  get lastBusyAt(): number {
    return this.round.lastBusyAt
  }
  set lastBusyAt(value: number) {
    this.round.lastBusyAt = value
  }

  get lastActiveAt(): number {
    return this.round.lastActiveAt
  }
  set lastActiveAt(value: number) {
    this.round.lastActiveAt = value
  }

  get lastSelfInjection(): { text: string; at: number } | undefined {
    return this.round.lastSelfInjection
  }
  set lastSelfInjection(value: { text: string; at: number } | undefined) {
    this.round.lastSelfInjection = value
  }

  get toolFailureCount(): number {
    return this.round.toolFailureCount
  }
  set toolFailureCount(value: number) {
    this.round.toolFailureCount = value
  }

  get toolFailureIds(): string[] {
    return this.round.toolFailureIds
  }
  set toolFailureIds(value: string[]) {
    this.round.toolFailureIds = value
  }
}

export class WatchStore {
  private readonly watched = new Map<string, WatchState>()
  /** Cross-round operation state (in-flight injection lock, running verify). */
  private readonly locks = new Map<string, SessionLock>()
  /** Per-round cache; reset when a new watch round starts. */
  private readonly rounds = new Map<string, RoundCache>()
  /** Live merged views handed out by getMemory(). */
  private readonly views = new Map<string, SessionMemoryView>()
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
        // The round counter must stay ahead of EVERY persisted round id, so a
        // fresh watch()/resume() never hands out an id that a stale
        // verification result could still carry.
        let highestPersistedRoundId = 0
        for (const persisted of Object.values(saved) as unknown[]) {
          const persistedRoundId =
            persisted && typeof persisted === "object"
              ? (persisted as { roundId?: unknown }).roundId
              : undefined
          if (
            typeof persistedRoundId === "number" &&
            Number.isFinite(persistedRoundId) &&
            persistedRoundId > highestPersistedRoundId
          ) {
            highestPersistedRoundId = persistedRoundId
          }
        }
        if (highestPersistedRoundId > processRoundIdCounter) {
          processRoundIdCounter = highestPersistedRoundId
        }
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

  /** Live view of a session's lock and round cache. The returned object stays
   *  valid across a new watch round (the round cache is reset in place) and
   *  every field write goes through to the underlying records. */
  getMemory(sessionID: string): InMemoryState {
    let view = this.views.get(sessionID)
    if (!view) {
      view = new SessionMemoryView(this.getLock(sessionID), this.getRoundCache(sessionID))
      this.views.set(sessionID, view)
    }
    return view
  }

  /** The in-flight lock of a session. It survives a new watch round. */
  getLock(sessionID: string): SessionLock {
    let lock = this.locks.get(sessionID)
    if (!lock) {
      lock = { inFlight: false, verifying: false }
      this.locks.set(sessionID, lock)
    }
    return lock
  }

  /** The per-round cache of a session. */
  getRoundCache(sessionID: string): RoundCache {
    let round = this.rounds.get(sessionID)
    if (!round) {
      round = {
        frustrationPending: false,
        pendingContinue: false,
        pendingContinueAt: 0,
        lastUserMessageAt: 0,
        lastBusyAt: 0,
        lastActiveAt: 0,
        toolFailureCount: 0,
        toolFailureIds: [],
      }
      this.rounds.set(sessionID, round)
    }
    return round
  }

  /** Take the next round id from the process-wide monotonic counter. */
  private allocateRoundId(): number {
    processRoundIdCounter += 1
    return processRoundIdCounter
  }

  /** Reset the per-round cache of a session. The in-flight lock is NOT
   *  touched: it belongs to the injection lifecycle, not to the round. */
  private resetRoundCache(sessionID: string): void {
    const round = this.getRoundCache(sessionID)
    round.frustrationPending = false
    round.pendingContinue = false
    round.pendingContinueAt = 0
    round.lastUserMessageAt = 0
    round.lastBusyAt = 0
    round.lastActiveAt = 0
    round.lastSelfInjection = undefined
    round.toolFailureCount = 0
    round.toolFailureIds = []
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
      // A fresh watch starts a new round: take a fresh id from the global
      // counter (never 0) so a verification result from an earlier round is
      // recognized as stale. resume() takes the next id from the same counter.
      roundId: this.allocateRoundId(),
      state: "watching",
      endAt,
    }
    this.watched.set(sessionID, entry)
    // The per-round cache is reset, but the in-flight lock survives: an
    // injection that is still running must not be duplicated by the new round.
    this.resetRoundCache(sessionID)
    await this.persist()
    return entry
  }

  /** Disable watching for a session. */
  async unwatch(sessionID: string): Promise<void> {
    this.watched.delete(sessionID)
    // Both concerns are dropped: the lock AND the round cache.
    this.locks.delete(sessionID)
    this.rounds.delete(sessionID)
    this.views.delete(sessionID)
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
    // The round id advances to a FRESH id from the global counter (not a
    // per-session +1): ids are globally unique and strictly increasing, so a
    // verification result from a superseded round is always recognized as
    // stale — even after an "off -> on" switch, which used to reset the id
    // to 0 and could let a stale PASS mark the new round done.
    entry.roundId = this.allocateRoundId()
    // The wall-clock watch budget is measured per round: a new round starts a
    // fresh budget instead of inheriting the previous round's remainder.
    // `since` is deliberately NOT touched — it marks the start of the whole
    // watch and drives the sidebar timer.
    entry.roundSince = Date.now()
    // 用户新消息代表新一轮对话：清掉 pendingContinue 闩锁（错误已解决）。
    // 但保留 lastUserMessageAt——宽限期判定仍依赖它，整删内存会破坏 userGraceMs。
    const round = this.rounds.get(sessionID)
    if (round) {
      round.pendingContinue = false
      round.pendingContinueAt = 0
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
    return this.locks.get(sessionID)?.verifying ?? false
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
    const lock = this.locks.get(sessionID)
    const round = this.rounds.get(sessionID)
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
        verifying: lock?.verifying ?? false,
        toolFailureCount: round?.toolFailureCount ?? 0,
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
      verifying: this.locks.get(entry.sessionID)?.verifying ?? false,
      toolFailureCount: this.rounds.get(entry.sessionID)?.toolFailureCount ?? 0,
      // Only present while the round carries a stop reason.
      ...(entry.stopReason !== undefined ? { stopReason: entry.stopReason } : {}),
    }))
  }
}
