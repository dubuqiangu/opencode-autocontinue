// Core decision engine for opencode-autocontinue.
// Owns the retry hook and the unified error/idle/interval -> inject pipeline.
//
// Unified architecture (v0.3.0):
// - A single decision point `maybeInject(sessionID)` is reached by every
//   trigger source: a per-session interval timer, a session.idle event, or a
//   retryable error. There is no separate "keep-alive" path anymore.
// - A single counter `injections` counts every injection in the current round
//   (retries + final checks + periodic). It drives the maxConsecutive cap and
//   the sidebar display.
// - Completion flow is two-phase: a completion marker while "watching" injects
//   the finalCheckMessage and moves the state to "confirming"; a second
//   completion marker while "confirming" marks the session "done". A fresh user
//   message or a non-marker assistant turn returns "confirming" to "watching".
// - `watchTimeoutMs` (0 = unlimited) stops the watch round after a wall-clock
//   budget, independent of the daily endTime window.

import type { PluginConfig } from "./config.ts"
import { buildCompletionMatcher } from "./config.ts"
import type { WatchStore, InMemoryState } from "./state.ts"
import { injectContinuation, isPluginInjection } from "./prompt.ts"
import {
  hasCompletionMarker,
  isRetryableError,
  looksIncomplete,
  matchSentinel,
  messageText,
  idleOutcomeFromEvent,
  sessionIDFromEvent,
  sessionIDFromMessageInfo,
  titleExcluded,
} from "./events.ts"
import type { WatchState, WatchStatusEvent } from "./rpc.ts"
import { buildVerifyDetail, runVerification, verificationArgv } from "./verify.ts"
import type { SpawnSpec, VerifyResult } from "./verify.ts"

export interface SessionLike {
  prompt(input: {
    sessionID: string
    text: string
    metadata?: Record<string, unknown>
  }): Promise<unknown>
  synthetic?(input: {
    sessionID: string
    text: string
    description?: string
    metadata?: Record<string, unknown>
    resume?: boolean
  }): Promise<unknown>
  hook(name: string, callback: (event: any) => void | Promise<void>): Promise<unknown>
  context(input: { sessionID: string }): Promise<readonly unknown[]>
  get(input: { sessionID: string }): Promise<unknown>
}

export interface EventLike {
  type?: string
  sessionID?: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
  info?: Record<string, unknown>
  outcome?: unknown
}

/** Convert "HH:MM" to today's epoch ms. Empty endTime -> 0 (disabled).
 *  Cross-midnight windows (endTime clock earlier than startTime clock, e.g.
 *  22:00 → 08:30) roll endAt to tomorrow once today's endTime has passed, so a
 *  night watch started at 23:00 does not instantly stop. Non-cross-midnight
 *  windows keep the original semantics: a passed endTime still returns today's
 *  timestamp so the daily cutoff is immediately closed (stop watching). */
export function computeEndAt(endTime: string, startTime: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(endTime.trim())
  if (!match) return 0
  const now = new Date()
  const today = new Date(now)
  today.setHours(Number(match[1]), Number(match[2]), 0, 0)
  const startMatch = /^(\d{1,2}):(\d{2})$/.exec((startTime ?? "").trim())
  let crossMidnight = false
  if (startMatch) {
    const startToday = new Date(now)
    startToday.setHours(Number(startMatch[1]), Number(startMatch[2]), 0, 0)
    // endTime 时刻早于 startTime 时刻（如 22:00 → 08:30）即跨日窗口。
    crossMidnight = today.getTime() < startToday.getTime()
  }
  if (now.getTime() >= today.getTime() && crossMidnight) {
    today.setDate(today.getDate() + 1)
  }
  return today.getTime()
}

export function startTimeNotReached(startTime: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(startTime.trim())
  if (!match) return false
  const now = new Date()
  const start = new Date(now)
  start.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return now.getTime() < start.getTime()
}

/** Cross-midnight-aware start gate: true only when the watch window is
 *  genuinely NOT open yet.
 *  - Empty/invalid startTime -> false (always open), mirroring
 *    startTimeNotReached.
 *  - Non-cross-midnight window -> identical to startTimeNotReached: `now`
 *    before startTime means the window has not opened.
 *  - Cross-midnight window (endTime clock earlier than startTime clock, e.g.
 *    22:00 -> 08:30): after midnight `now` is before startTime, but while it is
 *    also before endTime we are in the post-midnight tail where the window is
 *    STILL OPEN, so the gate must not close. */
export function startGateClosed(startTime: string, endTime: string): boolean {
  const startMatch = /^(\d{1,2}):(\d{2})$/.exec((startTime ?? "").trim())
  if (!startMatch) return false
  const now = new Date()
  const start = new Date(now)
  start.setHours(Number(startMatch[1]), Number(startMatch[2]), 0, 0)
  if (now.getTime() >= start.getTime()) return false
  // now < startTime: genuinely closed only when the window is not cross-midnight,
  // or when the clock is already past the cross-midnight endTime (the pre-start
  // gap, not the post-midnight tail).
  const endMatch = /^(\d{1,2}):(\d{2})$/.exec((endTime ?? "").trim())
  if (!endMatch) return true
  const end = new Date(now)
  end.setHours(Number(endMatch[1]), Number(endMatch[2]), 0, 0)
  const crossMidnight = end.getTime() < start.getTime()
  if (crossMidnight && now.getTime() < end.getTime()) return false
  return true
}

/** Replace a provider failure's retry decision when it looks transient. */
export function retryHookHandler(
  config: () => PluginConfig,
  _event: {
    error?: { type?: string; message?: string; status?: number }
    attempt?: number
    decision: { retry: boolean; delay?: number }
  },
): void {
  const cfg = config()
  if (!cfg.enabled) return
  const error = _event.error
  const attempt = _event.attempt ?? 1
  const status = error?.status
  const matchString = `${error?.type ?? ""}: ${error?.message ?? ""}${
    status !== undefined && status !== null ? ` (status: ${status})` : ""
  }`.toLowerCase()
  const excluded = cfg.excludePatterns.some((pattern) => matchString.includes(pattern.toLowerCase()))
  if (excluded) return
  const matched = cfg.errorPatterns.some((pattern) => matchString.includes(pattern.toLowerCase()))
  if (!matched) return
  // Exponential backoff, capped at 60s. Respect the built-in max attempt count.
  const delay = Math.min(2_000 * 2 ** Math.max(0, attempt - 1), 60_000)
  _event.decision = { retry: true, delay }
}

/** Pick the pressure-ladder row for the current rejection count.
 *  Tiers: `<=3 / <=7 / <=15 / <=30 / <=50 / else` map to rows 0..5. A shorter
 *  ladder clamps to its last row; an empty ladder returns "" (no pressure line). */
export function selectPressureMessage(ladder: string[], rejections: number): string {
  if (ladder.length === 0) return ""
  const lastIndex = ladder.length - 1
  const tier =
    rejections <= 3
      ? 0
      : rejections <= 7
        ? 1
        : rejections <= 15
          ? 2
          : rejections <= 30
            ? 3
            : rejections <= 50
              ? 4
              : 5
  return ladder[Math.min(tier, lastIndex)] ?? ""
}

/** Compose the verify-failure prompt: base message + failure count, then the
 *  pressure-ladder row, then the reassess (>=3) and root-cause (>=5) additions. */
export function composeRejectionPrompt(cfg: PluginConfig, rejections: number): string {
  const lines = [cfg.message, `🚫 验证未通过（连续第 ${rejections} 次）。`]
  const pressure = selectPressureMessage(cfg.escalationPressureLadder, rejections)
  if (pressure) lines.push(pressure)
  if (rejections >= 3 && cfg.escalationReassessMessage) lines.push(cfg.escalationReassessMessage)
  if (rejections >= 5 && cfg.escalationRootCauseMessage) lines.push(cfg.escalationRootCauseMessage)
  return lines.join("\n")
}

/** Case-insensitive substring match of a real user message against the
 *  configured frustration triggers. An empty trigger list disables the
 *  feature (the default), so nothing is ever reported then. */
export function matchesFrustration(text: string | undefined, triggers: string[]): boolean {
  if (!text || triggers.length === 0) return false
  const loweredText = text.toLowerCase()
  return triggers.some(
    (trigger) => trigger.length > 0 && loweredText.includes(trigger.toLowerCase()),
  )
}

export class AutocontinueEngine {
  private readonly session: SessionLike
  private readonly config: () => PluginConfig
  private readonly store: WatchStore
  private readonly emitChanged: (event: WatchStatusEvent) => void
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per-session interval timers (periodic re-checks). */
  private readonly intervalTimers = new Map<string, ReturnType<typeof setInterval>>()
  private disposed = false
  private titleCache = new Map<string, string>()
  /** Per-session last completion-check time (P2-6 throttle). */
  private lastCompletionCheckAt = new Map<string, number>()
  /** Assistant-message count when the session entered confirming. A second
   *  completion marker only counts in a message produced AFTER this point —
   *  the old marker message must not re-trigger done (B1 guard). */
  private confirmingAtAssistantCount = new Map<string, number>()
  /** In-flight verification AbortControllers (per session), so off / dispose /
   *  session.deleted can cancel a running command. */
  private readonly activeVerifyControllers = new Map<string, AbortController>()
  /** Verification runner seam: production runs the real command, tests inject a
   *  fake so the gate can be exercised without spawning a process. */
  private readonly verifyRunner: (spec: SpawnSpec) => Promise<VerifyResult>
  /** Project directory used as the default verification cwd when `verifyCwd`
   *  is empty. The host server process cwd is not necessarily the project, so
   *  a running command must default here instead of to process.cwd(). */
  private readonly baseDirectory: string | undefined

  constructor(
    session: SessionLike,
    config: () => PluginConfig,
    store: WatchStore,
    emitChanged: (event: WatchStatusEvent) => void,
    verifyRunner?: (spec: SpawnSpec) => Promise<VerifyResult>,
    baseDirectory?: string,
  ) {
    this.session = session
    this.config = config
    this.store = store
    this.emitChanged = emitChanged
    this.verifyRunner = verifyRunner ?? ((spec) => runVerification(spec))
    this.baseDirectory = baseDirectory
  }

  /** Register the retry hook. */
  async installRetryHook(): Promise<void> {
    try {
      await this.session.hook("retry", (event) => retryHookHandler(this.config, event))
    } catch (error) {
      console.error("[opencode-autocontinue] retry hook registration failed:", error)
    }
  }

  /** Timer-managed injection with throttle and window checks. */
  private scheduleInjection(sessionID: string, delayMs: number): void {
    const existing = this.timers.get(sessionID)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(sessionID)
      void this.maybeInject(sessionID)
    }, delayMs)
    this.timers.set(sessionID, timer)
  }

  /** Cancel any pending injection timeout for a session (used by the RPC
   *  off path so a scheduled injection cannot fire after unwatch). */
  clearTimer(sessionID: string): void {
    const timer = this.timers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionID)
    }
  }

  /** Drop per-session caches (title, completion-check throttle). Called on
   *  unwatch / session.deleted so memory does not grow and a re-watched
   *  session re-resolves a fresh title. */
  forgetSession(sessionID: string): void {
    this.titleCache.delete(sessionID)
    this.lastCompletionCheckAt.delete(sessionID)
    this.confirmingAtAssistantCount.delete(sessionID)
  }

  /** Start the per-session interval timer (periodic re-check). No-op when disabled. */
  scheduleInterval(sessionID: string): void {
    const cfg = this.config()
    if (this.disposed || !cfg.enabled || cfg.intervalMs <= 0) return
    if (this.intervalTimers.has(sessionID)) return
    const timer = setInterval(() => {
      void this.maybeInject(sessionID)
    }, cfg.intervalMs)
    this.intervalTimers.set(sessionID, timer)
  }

  /** Stop the per-session interval timer. Idempotent. */
  stopInterval(sessionID: string): void {
    const timer = this.intervalTimers.get(sessionID)
    if (timer) {
      clearInterval(timer)
      this.intervalTimers.delete(sessionID)
    }
  }

  /** Start intervals for every currently-watching session (post-hydrate). */
  resumeKeepAlives(): void {
    for (const status of this.store.list()) {
      if (status.state === "watching" || status.state === "confirming") {
        this.scheduleInterval(status.sessionID)
      }
    }
  }

  /** Abort a still-running verification command (off / dispose / session.deleted
   *  / a new real user round). Idempotent. */
  abortVerify(sessionID: string): void {
    const controller = this.activeVerifyControllers.get(sessionID)
    if (!controller) return
    controller.abort()
    this.activeVerifyControllers.delete(sessionID)
  }

  /** Inject a continuation and arm the self-echo guard with the rendered text. */
  private async injectAndRecord(
    memory: InMemoryState,
    sessionID: string,
    template: string,
    endAt: number,
  ): Promise<string> {
    const cfg = this.config()
    // P2 (frustration): a frustrated real user turn decorates the NEXT
    // injection with the reminder clause. Compose it into the template BEFORE
    // injecting so the self-echo guard records exactly the text we send.
    const decorate = memory.frustrationPending && cfg.frustrationMessage !== ""
    const composed = decorate ? `${template}\n\n${cfg.frustrationMessage}` : template
    if (decorate) memory.frustrationPending = false
    const text = await injectContinuation(this.session, sessionID, composed, endAt)
    memory.lastSelfInjection = { text, at: Date.now() }
    return text
  }

  /** Whether an inbound "user" message is actually our own injection returning.
   *  Metadata provenance is authoritative; the self-echo record is the
   *  host-agnostic fallback for hosts that do not round-trip metadata. */
  private isSelfEcho(
    memory: InMemoryState,
    metadata: unknown,
    inboundText: string | undefined,
  ): boolean {
    if (isPluginInjection(metadata)) return true
    const record = memory.lastSelfInjection
    if (!record) return false
    if (Date.now() - record.at > this.config().selfEchoWindowMs) return false
    // Require exact text equality: without extractable text we never swallow a
    // message that might be a real user turn.
    if (inboundText === undefined || inboundText === "") return false
    return inboundText === record.text
  }

  /** Verify-driven completion gate (Loop mode), reached only when
   *  `verifyCommand` is configured. Completion is judged solely by an
   *  independent command's exit code, not the model's self-report. */
  private async runVerifyGate(
    sessionID: string,
    entry: WatchState,
    latest: { text: string; parts: unknown },
    hasSignal: boolean,
    memory: InMemoryState,
  ): Promise<void> {
    const cfg = this.config()
    // B-2 (gating): with no completion signal, verification must NOT run — a
    // clean-tree `npm test` would otherwise judge an idle round as done. Fall
    // back to the ordinary continuation behaviour.
    if (!hasSignal) {
      if (looksIncomplete(latest.text, latest.parts)) return
      if (this.disposed) return
      const freshEntry = this.store.getState(sessionID)
      if (!freshEntry || (freshEntry.state !== "watching" && freshEntry.state !== "confirming")) return
      if (memory.lastUserMessageAt && Date.now() - memory.lastUserMessageAt < cfg.userGraceMs) return
      await this.injectAndRecord(memory, sessionID, cfg.message, freshEntry.endAt ?? 0)
      await this.store.recordInjection(sessionID)
      void this.emitChangedInternal(sessionID, "watching")
      return
    }

    // F2 (pre-command TOCTOU): `entry` is a live object reference captured
    // before maybeInject's awaits (resolveTitle / latestAssistantText). A real
    // user message landing during those awaits bumps that same object's roundId
    // via resume(), so reading roundBefore from it would record the NEW id and
    // the post-command staleness check would wrongly pass. Re-read a fresh
    // snapshot and validate BEFORE starting the command.
    const freshGate = this.store.getState(sessionID)
    if (!freshGate || (freshGate.state !== "watching" && freshGate.state !== "confirming")) return
    if (memory.lastUserMessageAt && Date.now() - memory.lastUserMessageAt < cfg.userGraceMs) return
    // B-4: capture the round identity BEFORE awaiting the command.
    const roundBefore = freshGate.roundId
    const controller = new AbortController()
    memory.activeVerifyAbort = controller
    this.activeVerifyControllers.set(sessionID, controller)
    // Surface "verifying" to the TUI before awaiting the command; cleared in
    // the finally below. The post-result emitChangedInternal calls carry the
    // cleared value.
    memory.verifying = true
    void this.emitChangedInternal(sessionID, entry.state)
    let outcome: VerifyResult
    try {
      outcome = await this.verifyRunner({
        argv: verificationArgv(cfg.verifyCommand, process.platform),
        cwd: cfg.verifyCwd || this.baseDirectory || process.cwd(),
        timeoutMs: cfg.verifyTimeoutMs,
        signal: controller.signal,
      })
    } finally {
      memory.verifying = false
      this.activeVerifyControllers.delete(sessionID)
      if (memory.activeVerifyAbort === controller) memory.activeVerifyAbort = undefined
    }

    // B-4 (staleness): the session may have been unwatched / done / stopped /
    // resumed into a new round / disposed, or the window may have closed while
    // the command ran. Discard the stale result — no inject, no done.
    if (this.disposed) return
    const after = this.store.getState(sessionID)
    if (!after || (after.state !== "watching" && after.state !== "confirming")) return
    if (after.roundId !== roundBefore) return
    if (after.endAt && Date.now() >= after.endAt) return
    if (cfg.watchTimeoutMs > 0 && Date.now() - after.since >= cfg.watchTimeoutMs) return

    if (outcome.pass) {
      await this.store.markDone(sessionID)
      this.clearTimer(sessionID)
      this.stopInterval(sessionID)
      void this.emitChangedInternal(sessionID, "done")
      return
    }

    // B-3: verify-then-cap. Count the failure first, THEN apply the cap, so the
    // final failing round is judged stopped instead of silently continuing.
    await this.store.recordRejection(sessionID)
    const rejections = this.store.getState(sessionID)?.rejections ?? 0
    if (cfg.verifyMaxIterations > 0 && rejections >= cfg.verifyMaxIterations) {
      await this.store.markStopped(sessionID, "verify-limit")
      this.clearTimer(sessionID)
      this.stopInterval(sessionID)
      void this.emitChangedInternal(sessionID, "stopped")
      return
    }

    const prompt = composeRejectionPrompt(cfg, rejections)
    const detail = buildVerifyDetail(cfg.verifyCommand, outcome)
    await this.injectAndRecord(memory, sessionID, `${prompt}\n\n${detail}`, after.endAt ?? 0)
    await this.store.recordInjection(sessionID)
    void this.emitChangedInternal(sessionID, "watching")
  }

  /** Unified injection decision reached by every trigger source. Single-flight
   *  per session (inFlight). The completion flow is two-phase (watching ->
   *  confirming -> done) with an optional whole-project review + doc sync in
   *  between. `injections` counts every injection and drives maxConsecutive. */
  private async maybeInject(sessionID: string): Promise<void> {
    const cfg = this.config()
    const memory = this.store.getMemory(sessionID)
    if (this.disposed || !cfg.enabled) return
    if (memory.inFlight) return
    // Set the lock at entry: later awaits (title, latest message) must not let
    // concurrent triggers double-inject (TOCTOU window).
    memory.inFlight = true
    try {
      const entry = this.store.getState(sessionID)
      if (!entry || (entry.state !== "watching" && entry.state !== "confirming")) {
        this.stopInterval(sessionID)
        return
      }

      // Time window (endAt frozen at watch time).
      if (startGateClosed(cfg.startTime, cfg.endTime)) return
      if (entry.endAt && Date.now() >= entry.endAt) {
        await this.store.markStopped(sessionID, "window-closed")
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        void this.emitChangedInternal(sessionID, "stopped")
        return
      }

      // Wall-clock watch budget (watchTimeoutMs = 0 means no limit).
      if (cfg.watchTimeoutMs > 0 && Date.now() - entry.since >= cfg.watchTimeoutMs) {
        await this.store.markStopped(sessionID, "watch-timeout")
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        void this.emitChangedInternal(sessionID, "stopped")
        return
      }

      // Injection cap.
      if (cfg.maxConsecutive > 0 && entry.injections >= cfg.maxConsecutive) {
        await this.store.markStopped(sessionID, "injection-cap")
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        void this.emitChangedInternal(sessionID, "stopped")
        return
      }

      // User grace: if the user just sent a real message, wait.
      if (memory.lastUserMessageAt && Date.now() - memory.lastUserMessageAt < cfg.userGraceMs) {
        this.scheduleInjection(sessionID, Math.max(cfg.idleDelayMs, 10_000))
        return
      }

      // Session title exclusion.
      const title = await this.resolveTitle(sessionID)
      if (titleExcluded(title, cfg.excludeTitleKeywords)) {
        await this.store.markStopped(sessionID)
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        void this.emitChangedInternal(sessionID, "stopped")
        return
      }

      // Model active recently (busy/retry within the last 60s) — don't interrupt.
      if (memory.lastBusyAt && Date.now() - memory.lastBusyAt < 60_000) return

      // Session actively running/streaming (execution started, step started/
      // streamed, or busy status) — don't poke a live run. idleDelayMs grace so
      // a just-settled session can be resumed promptly.
      if (memory.lastActiveAt && Date.now() - memory.lastActiveAt < cfg.idleDelayMs) return

      // Min interval between injections.
      if (entry.lastInjectedAt && Date.now() - entry.lastInjectedAt < cfg.minIntervalMs) {
        const remaining = cfg.minIntervalMs - (Date.now() - entry.lastInjectedAt)
        this.scheduleInjection(sessionID, remaining + 100)
        return
      }

      // Inspect the latest assistant message to decide what to do.
      const matcher = buildCompletionMatcher(cfg)
      const latest = await this.latestAssistantText(sessionID)
      const hasMarker = hasCompletionMarker(latest.text, matcher)

      // Opt-in tool-failure observation (observation only; never affects the
      // completion/stop decision) — recorded before any branch.
      if (cfg.observeToolFailures) {
        this.store.observeToolOutcome(sessionID, latest.lastToolId, latest.lastToolErrored)
      }

      // Abort / pause sentinels (paired tags in the assistant text, shared by
      // verify and non-verify modes). Only the assistant text is scanned — the
      // verify command's output (verify.detail) is untrusted data and is never
      // consulted for control flow (§3.7).
      // F8: an explicit abort must beat the background-work guard below — a
      // running (or orphaned non-terminal) subagent must never make the model's
      // explicit abort be ignored.
      if (matchSentinel(latest.text, cfg.abortSentinelTag)) {
        await this.store.markStopped(sessionID, "abort-sentinel")
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        void this.emitChangedInternal(sessionID, "stopped")
        return
      }

      // User's guard: if a background subagent/task is still running, do NOT
      // mark done and do NOT inject a continuation — the overall task is not
      // complete until the background work settles. Keep watching so the next
      // trigger re-checks once the subagent finishes.
      if (latest.backgroundWorkRunning) return

      // Pause sentinel stays AFTER the background-work guard: pausing is not a
      // hard override of in-flight work, unlike abort.
      if (matchSentinel(latest.text, cfg.pauseSentinelTag)) {
        await this.store.markPaused(sessionID)
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        void this.emitChangedInternal(sessionID, "paused")
        return
      }

      // Verify mode replaces the marker / final-check flow entirely: the
      // outcome is judged only by the configured command (see runVerifyGate).
      if (cfg.verifyCommand) {
        await this.runVerifyGate(sessionID, entry, latest, hasMarker, memory)
        return
      }

      // While confirming (whole-project review round in flight), a second
      // completion marker only counts if it appears in a NEW assistant message
      // produced after the finalCheckMessage injection. Until the model
      // replies, the old marker message is still the latest — counting it
      // again would mark the session done without ever running the review (B1).
      const confirming = entry.state === "confirming"
      const reviewing =
        confirming &&
        latest.assistantCount > (this.confirmingAtAssistantCount.get(sessionID) ?? 0)

      if (confirming) {
        if (!reviewing) return // model hasn't replied to the review prompt yet
        if (hasMarker) {
          // Second marker in the review's own reply: genuinely done.
          await this.store.markDone(sessionID)
          this.clearTimer(sessionID)
          this.stopInterval(sessionID)
          void this.emitChangedInternal(sessionID, "done")
          return
        }
        // Review reply carries no marker: work is not claimed complete.
        // Return to watching (keep the injection counter) and let the next
        // trigger continue the round (B2 — non-marker assistant turn).
        if (looksIncomplete(latest.text, latest.parts)) return
        await this.store.continueWatching(sessionID)
        this.confirmingAtAssistantCount.delete(sessionID)
        void this.emitChangedInternal(sessionID, "watching")
        return
      }
      if (hasMarker && cfg.finalCheckEnabled) {
        // First marker while watching: run the whole-project review round.
        this.confirmingAtAssistantCount.set(sessionID, latest.assistantCount)
        await this.store.beginConfirming(sessionID)
        this.clearTimer(sessionID)
        void this.emitChangedInternal(sessionID, "confirming")
        await this.injectAndRecord(memory, sessionID, cfg.finalCheckMessage, entry.endAt ?? 0)
        await this.store.recordInjection(sessionID)
        void this.emitChangedInternal(sessionID, "confirming")
        return
      }
      if (hasMarker) {
        // Marker but final check disabled: done immediately.
        await this.store.markDone(sessionID)
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        void this.emitChangedInternal(sessionID, "done")
        return
      }
      // Mid-task (asking a question, tool in flight, short ack) — skip this
      // round; the next trigger re-checks.
      if (looksIncomplete(latest.text, latest.parts)) return

      // 注入前复查：上面 await 期间 session 可能已被 unwatch / markDone /
      // markStopped，或用户已发真实消息（P2-2）。逐项复核，避免注入打断用户输入。
      if (this.disposed) return
      const freshEntry = this.store.getState(sessionID)
      if (!freshEntry || (freshEntry.state !== "watching" && freshEntry.state !== "confirming")) return
      if (memory.lastUserMessageAt && Date.now() - memory.lastUserMessageAt < cfg.userGraceMs) return

      await this.injectAndRecord(memory, sessionID, cfg.message, freshEntry.endAt ?? 0)
      await this.store.recordInjection(sessionID)
      void this.emitChangedInternal(sessionID, "watching")
    } catch (error) {
      console.error("[opencode-autocontinue] injection failed:", error)
    } finally {
      memory.inFlight = false
    }
  }

  private async latestAssistantText(sessionID: string): Promise<{
    text: string
    parts: unknown
    assistantCount: number
    backgroundWorkRunning: boolean
    /** Id of the LAST tool part seen (`callID ?? id`), for the opt-in failure counter. */
    lastToolId: string | undefined
    /** Whether that last tool part ended in an error. */
    lastToolErrored: boolean
  }> {
    try {
      // V1 messages carry { info: { role }, parts }, V2 carry
      // { type: "assistant", content } — accept both so completion detection
      // works against the actual host message shape (v2 host verified).
      const messages = (await this.session.context({ sessionID })) as Array<
        | { info?: { role?: string }; parts?: unknown }
        | { type?: string; content?: unknown }
      >
      let assistantCount = 0
      let latestText = ""
      let latestParts: unknown = undefined
      let backgroundWorkRunning = false
      let lastToolId: string | undefined
      let lastToolErrored = false
      for (const message of messages) {
        const role = (message as { info?: { role?: string } }).info?.role
        const type = (message as { type?: string }).type
        if (role === "assistant" || type === "assistant") {
          assistantCount += 1
          const parts = (message as { parts?: unknown }).parts
          const content = (message as { content?: unknown }).content
          latestText = messageText(parts) || messageText(content)
          latestParts = parts ?? content
        }
        // Record the LAST tool part so the opt-in failure counter can observe
        // its outcome. This scan runs for EVERY message, not just assistant
        // ones: V2 parts live on assistant messages, but V1 tool_result parts
        // arrive in a separate user/tool message, so scanning only inside the
        // assistant branch would never see them. Scanning in message order
        // yields the same V2 result as before.
        // V2: { type:"tool", callID?, id?, state:{status} }.
        // V1: tool_use records its id; a later tool_result with is_error
        // resolves whether it errored (id backfilled from tool_use_id).
        const scannedParts =
          (message as { parts?: unknown }).parts ?? (message as { content?: unknown }).content
        const partList = Array.isArray(scannedParts) ? scannedParts : []
        for (const part of partList) {
          if (!part || typeof part !== "object") continue
          const partType = (part as { type?: string }).type
          if (partType === "tool") {
            const toolPart = part as { callID?: string; id?: string; state?: { status?: string } }
            lastToolId = toolPart.callID ?? toolPart.id
            lastToolErrored = toolPart.state?.status === "error"
          } else if (partType === "tool_use") {
            const toolUsePart = part as { callID?: string; id?: string }
            lastToolId = toolUsePart.callID ?? toolUsePart.id
            lastToolErrored = false
          } else if (partType === "tool_result") {
            if ((part as { is_error?: boolean }).is_error === true) lastToolErrored = true
            const resultId =
              (part as { tool_use_id?: string }).tool_use_id ??
              (part as { toolUseID?: string }).toolUseID
            if (resultId) lastToolId = resultId
          }
        }
        // Background subagent/task in flight: a synthetic message whose metadata
        // says it is a subagent and has no terminal state yet means the overall
        // task is NOT done even if the latest assistant text carries a
        // completion marker. Terminal states: completed / cancelled / error /
        // failed. A running subagent has no state (or state === "running").
        if (type === "synthetic") {
          const metadata = (message as { metadata?: { source?: string; state?: string } }).metadata
          // Our own continuation injections also arrive as "synthetic" on hosts
          // that support the channel; exclude them explicitly so a future
          // metadata drift can never read our injection as background work.
          if (!isPluginInjection(metadata) && metadata?.source === "subagent") {
            const subagentState = metadata.state
            const terminal =
              subagentState === "completed" ||
              subagentState === "cancelled" ||
              subagentState === "error" ||
              subagentState === "failed"
            if (!terminal) backgroundWorkRunning = true
          }
        }
      }
      return {
        text: latestText,
        parts: latestParts,
        assistantCount,
        backgroundWorkRunning,
        lastToolId,
        lastToolErrored,
      }
    } catch {
      // Fall through to empty.
    }
    return {
      text: "",
      parts: undefined,
      assistantCount: 0,
      backgroundWorkRunning: false,
      lastToolId: undefined,
      lastToolErrored: false,
    }
  }

  private async resolveTitle(sessionID: string): Promise<string | undefined> {
    if (this.titleCache.has(sessionID)) return this.titleCache.get(sessionID)
    try {
      // V1: title lives on a message's info. V2: title lives on the session
      // (SessionInfo.title via session.get), not on individual messages.
      const messages = (await this.session.context({ sessionID })) as Array<{
        info?: { role?: string; title?: string }
      }>
      const title =
        messages.find((message) => typeof message.info?.title === "string")?.info?.title ??
        (await this.session.get({ sessionID }) as { title?: string } | null | undefined)?.title
      // P2-4: only cache when a title actually exists. Caching "" (or undefined)
      // would permanently exempt a session that later gains an excluded title
      // (e.g. "测试") from the title filter for the rest of the process.
      if (typeof title === "string" && title) this.titleCache.set(sessionID, title)
      return title
    } catch {
      return undefined
    }
  }

  private async emitChangedInternal(sessionID: string, state: WatchState["state"]): Promise<void> {
    const entry = this.store.getState(sessionID)
    this.emitChanged({
      sessionID,
      state,
      injections: entry?.injections ?? 0,
      totalInjections: entry?.totalInjections ?? 0,
      rejections: entry?.rejections ?? 0,
      verifying: this.store.isVerifying(sessionID),
      toolFailureCount: this.store.getMemory(sessionID).toolFailureCount,
      // Only present while the round carries a stop reason.
      ...(entry?.stopReason !== undefined ? { stopReason: entry.stopReason } : {}),
    })
  }

  /** Handle a single server event. */
  async handleEvent(event: EventLike): Promise<void> {
    if (!event) return
    const type = event.type
    const sessionID = sessionIDFromEvent(event)
    if (!sessionID) return

    const cfg = this.config()
    if (!cfg.enabled) return
    if (!this.store.isWatching(sessionID)) return

    const memory = this.store.getMemory(sessionID)

    switch (type) {
      case "session.status": {
        // V1 nests status under properties; V2 carries it on data.
        const status = (event.properties?.status ?? event.data?.status ?? event.status) as
          | { type?: string }
          | string
          | undefined
        const statusType = typeof status === "string" ? status : status?.type
        if (statusType === "busy" || statusType === "retry") {
          memory.lastBusyAt = Date.now()
          memory.lastActiveAt = Date.now()
        }
        break
      }
      // V2 surfaces an active run via execution/step events. Any of these means
      // the session is currently working (streaming or executing) — refresh the
      // lastActiveAt stamp so maybeInject holds off poking a live run.
      case "session.execution.started":
      case "session.step.started":
      case "session.step.streamed": {
        memory.lastActiveAt = Date.now()
        break
      }
      // V1 session.error; V2 surfaces retryable provider failures as
      // session.execution.failed / session.retry.scheduled (data.error).
      case "session.error":
      case "session.execution.failed":
      case "session.retry.scheduled": {
        const error = event.properties?.error ?? event.data?.error ?? event.error
        if (isRetryableError(error, cfg.errorPatterns, cfg.excludePatterns)) {
          memory.pendingContinue = true
          memory.pendingContinueAt = Date.now()
        }
        break
      }
      case "session.idle": {
        // V1: opencode emits an idle event with outcome "interrupted" when the
        // user manually stopped the run (Esc). V2: interruption is its own
        // event (session.execution.interrupted) — handled below. Treat the V1
        // interrupted outcome as an explicit stop: mark stopped and do not
        // schedule any further injection. Other idle outcomes (succeeded/
        // failed) keep the existing continue-on-idle behavior.
        if (idleOutcomeFromEvent(event) === "interrupted") {
          await this.store.markStopped(sessionID, "idle-interrupted")
          this.clearTimer(sessionID)
          this.stopInterval(sessionID)
          void this.emitChangedInternal(sessionID, "stopped")
          break
        }
        if (memory.pendingContinue) {
          memory.pendingContinue = false
          this.scheduleInjection(sessionID, Math.max(cfg.idleDelayMs, 1_000))
        } else {
          // Stage-complete idle without a recent error: also resume, so overall
          // unfinished work keeps going. Completion marker is checked inside.
          this.scheduleInjection(sessionID, cfg.idleDelayMs)
        }
        break
      }
      case "session.execution.interrupted": {
        // V2: user manually stopped the run (Esc) — explicit stop, mirroring the
        // V1 idle-with-outcome=interrupted path above.
        await this.store.markStopped(sessionID, "user-interrupted")
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        void this.emitChangedInternal(sessionID, "stopped")
        break
      }
      // V1 message.updated carries a message info; V2 surfaces new user/assistant
      // messages as session.inbox.enqueued (user) and streaming assistant
      // content as session.message.content.updated. Handle all three so the
      // user-reset and completion-detection paths work against the actual host.
      case "message.updated":
      case "session.inbox.enqueued":
      case "session.message.content.updated": {
        // V1: info is nested (properties.info) or flat. V2: the inbox item
        // carries the user/synthetic/compaction distinction on data.item.
        const info = event.properties?.info ?? event.info
        const inboxItem = event.data?.item as
          | {
              type?: string
              metadata?: unknown
              payload?: { metadata?: unknown; text?: unknown }
            }
          | undefined
        // The installed host nests provenance under item.payload.metadata and the
        // text under item.payload.text; read both defensively so the current
        // shape and the prompt() fallback stay covered.
        const itemMetadata =
          inboxItem?.payload?.metadata ??
          inboxItem?.metadata ??
          (info as { metadata?: unknown } | undefined)?.metadata
        const itemText =
          typeof inboxItem?.payload?.text === "string" ? inboxItem.payload.text : undefined
        // Only a REAL user message resets the round. Our own injected
        // continuation ("继续执行") also lands as type "user" on hosts without
        // the synthetic channel, so it must never zero the injection counter.
        if (inboxItem?.type === "user") {
          if (this.isSelfEcho(memory, itemMetadata, itemText)) {
            memory.lastSelfInjection = undefined
            break
          }
          // P2: a complaint about the delivered quality decorates the next
          // injection and keeps the rejection counter (the last delivery was
          // rejected). Matching happens AFTER the self-echo guard so our own
          // injected text can never trigger it.
          const frustrated = matchesFrustration(itemText, cfg.frustrationTriggers)
          if (frustrated) memory.frustrationPending = true
          memory.lastUserMessageAt = Date.now()
          // A real user turn supersedes any in-flight verification round.
          this.abortVerify(sessionID)
          await this.store.resume(sessionID, true, frustrated)
          this.confirmingAtAssistantCount.delete(sessionID)
          this.scheduleInterval(sessionID)
          void this.emitChangedInternal(sessionID, "watching")
          break
        }
        if (!info || typeof info !== "object") break
        const role = (info as { role?: string }).role
        if (role === "user") {
          // Same provenance/self-echo guard for the V1/prompt-fallback info
          // shape; metadata may ride on info.payload.metadata and the text on
          // the info parts.
          const infoMetadata =
            (info as { payload?: { metadata?: unknown } }).payload?.metadata ??
            (info as { metadata?: unknown }).metadata
          const infoText =
            messageText((info as { parts?: unknown }).parts) ||
            messageText((info as { content?: unknown }).content) ||
            undefined
          if (this.isSelfEcho(memory, infoMetadata, infoText)) {
            memory.lastSelfInjection = undefined
            break
          }
          // P2: same frustration handling as the V2 inbox branch — matched
          // AFTER the self-echo guard, and a complaint keeps the rejection
          // counter because the previous delivery was rejected.
          const frustrated = matchesFrustration(infoText, cfg.frustrationTriggers)
          if (frustrated) memory.frustrationPending = true
          memory.lastUserMessageAt = Date.now()
          this.abortVerify(sessionID)
          await this.store.resume(sessionID, true, frustrated)
          this.confirmingAtAssistantCount.delete(sessionID)
          this.scheduleInterval(sessionID)
          void this.emitChangedInternal(sessionID, "watching")
          break
        }
        if (role === "assistant") {
          const error = (info as { error?: unknown }).error
          if (error && isRetryableError(error, cfg.errorPatterns, cfg.excludePatterns)) {
            memory.pendingContinue = true
            break
          }
          const messageID = sessionIDFromMessageInfo(info as Record<string, unknown>)
          if (!messageID) break
          const matcher = buildCompletionMatcher(cfg)
          if (!matcher) break
          // P2-6: throttle the full-context completion check — streaming hosts
          // emit many message.updated events per message; pulling session
          // context on each one would stall the event loop. The unified
          // maybeInject re-checks completion right before any real injection, so
          // a throttled check here only delays detection, never misses it.
          const lastCheck = this.lastCompletionCheckAt.get(sessionID) ?? 0
          if (Date.now() - lastCheck < 2_000) break
          this.lastCompletionCheckAt.set(sessionID, Date.now())
          // Skip while the engine is mid-decision: maybeInject re-checks
          // completion right before any injection, so this is only an early
          // signal, never authoritative (prevents double finalCheck injection).
          if (memory.inFlight) break
          try {
            const latest = await this.latestAssistantText(sessionID)
            const hasMarker = hasCompletionMarker(latest.text, matcher)
            const current = this.store.getState(sessionID)
            // User's guard: a running background subagent means the overall task
            // is not done — skip completion decisions until it settles.
            if (latest.backgroundWorkRunning) break
            // B-1: in verify mode the event path must NOT decide completion
            // (markDone / beginConfirming / finalCheck injection). A detected
            // signal only schedules a maybeInject; the verify gate there owns
            // the decision.
            if (cfg.verifyCommand) {
              if (hasMarker) this.scheduleInjection(sessionID, Math.max(cfg.idleDelayMs, 1_000))
              break
            }
            if (current?.state === "confirming") {
              // Same B1/B2 guards as maybeInject: a second marker only counts
              // in a NEW assistant message; a non-marker review reply returns
              // to watching instead of injecting the generic message.
              const reviewing =
                latest.assistantCount > (this.confirmingAtAssistantCount.get(sessionID) ?? 0)
              if (!reviewing) break
              if (hasMarker) {
                await this.store.markDone(sessionID)
                this.clearTimer(sessionID)
                this.stopInterval(sessionID)
                void this.emitChangedInternal(sessionID, "done")
              } else if (!looksIncomplete(latest.text, latest.parts)) {
                await this.store.continueWatching(sessionID)
                this.confirmingAtAssistantCount.delete(sessionID)
                void this.emitChangedInternal(sessionID, "watching")
              }
            } else if (hasMarker && cfg.finalCheckEnabled) {
              this.confirmingAtAssistantCount.set(sessionID, latest.assistantCount)
              await this.store.beginConfirming(sessionID)
              this.clearTimer(sessionID)
              void this.emitChangedInternal(sessionID, "confirming")
              await this.injectAndRecord(memory, sessionID, cfg.finalCheckMessage, current?.endAt ?? 0)
              await this.store.recordInjection(sessionID)
              void this.emitChangedInternal(sessionID, "confirming")
            } else if (hasMarker) {
              await this.store.markDone(sessionID)
              this.clearTimer(sessionID)
              this.stopInterval(sessionID)
              void this.emitChangedInternal(sessionID, "done")
            }
          } catch {
            // Context read failure — the idle path will re-check before injection.
          }
        }
        break
      }
      case "session.deleted": {
        this.abortVerify(sessionID)
        this.store.unwatch(sessionID).catch(() => {})
        this.clearTimer(sessionID)
        this.stopInterval(sessionID)
        this.forgetSession(sessionID)
        break
      }
      default:
        break
    }
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.activeVerifyControllers.values()) controller.abort()
    this.activeVerifyControllers.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const timer of this.intervalTimers.values()) clearInterval(timer)
    this.intervalTimers.clear()
    this.titleCache.clear()
    this.lastCompletionCheckAt.clear()
    this.confirmingAtAssistantCount.clear()
  }
}