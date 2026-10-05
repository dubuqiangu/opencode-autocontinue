// Core decision engine for opencode-autocontinue.
// Owns the retry hook and the error/idle -> inject pipeline.

import type { PluginConfig } from "./config.ts"
import { buildCompletionMatcher } from "./config.ts"
import type { WatchStore } from "./state.ts"
import { injectContinuation } from "./prompt.ts"
import {
  hasCompletionMarker,
  isRetryableError,
  messageText,
  sessionIDFromEvent,
  sessionIDFromMessageInfo,
  titleExcluded,
} from "./events.ts"
import type { WatchState } from "./rpc.ts"

export interface SessionLike {
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  hook(name: string, callback: (event: any) => void | Promise<void>): Promise<unknown>
  context(input: { sessionID: string }): Promise<readonly unknown[]>
}

export interface EventLike {
  type?: string
  sessionID?: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
  info?: Record<string, unknown>
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

export class AutocontinueEngine {
  private readonly session: SessionLike
  private readonly config: () => PluginConfig
  private readonly store: WatchStore
  private readonly emitChanged: (sessionID: string, state: WatchState["state"], consecutive: number) => void
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per-session keep-alive interval timers (heartbeat injections). */
  private readonly intervalTimers = new Map<string, ReturnType<typeof setInterval>>()
  private disposed = false
  private titleCache = new Map<string, string>()

  constructor(
    session: SessionLike,
    config: () => PluginConfig,
    store: WatchStore,
    emitChanged: (sessionID: string, state: WatchState["state"], consecutive: number) => void,
  ) {
    this.session = session
    this.config = config
    this.store = store
    this.emitChanged = emitChanged
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
      void this.tryInject(sessionID)
    }, delayMs)
    this.timers.set(sessionID, timer)
  }

  private clearTimer(sessionID: string): void {
    const timer = this.timers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionID)
    }
  }

  /** Start the per-session keep-alive interval timer. No-op when disabled. */
  scheduleKeepAlive(sessionID: string): void {
    const cfg = this.config()
    if (this.disposed || !cfg.enabled || cfg.intervalMs <= 0) return
    if (this.intervalTimers.has(sessionID)) return
    const timer = setInterval(() => {
      void this.tryKeepAlive(sessionID)
    }, cfg.intervalMs)
    this.intervalTimers.set(sessionID, timer)
  }

  /** Stop the per-session keep-alive interval timer. Idempotent. */
  stopKeepAlive(sessionID: string): void {
    const timer = this.intervalTimers.get(sessionID)
    if (timer) {
      clearInterval(timer)
      this.intervalTimers.delete(sessionID)
    }
  }

  /** Start keep-alives for every currently-watching session (post-hydrate). */
  resumeKeepAlives(): void {
    for (const status of this.store.list()) {
      if (status.state === "watching") this.scheduleKeepAlive(status.sessionID)
    }
  }

  /** Periodic heartbeat: inject intervalMessage into an idle watching session.
   *  Skips while a recovery is in flight / pending, while the model has been
   *  active recently, inside the user grace window, or when the latest
   *  assistant message carries a completion marker (task truly done). Does not
   *  increment consecutive — it is a heartbeat, not a retry. */
  private async tryKeepAlive(sessionID: string): Promise<void> {
    const cfg = this.config()
    if (this.disposed || !cfg.enabled || cfg.intervalMs <= 0) return
    const entry = this.store.getState(sessionID)
    if (!entry || entry.state !== "watching") {
      this.stopKeepAlive(sessionID)
      return
    }
    const memory = this.store.getMemory(sessionID)
    // A recovery injection is in flight — let it own the conversation.
    if (memory.inFlight) return
    // An error recovery is pending — the error path will handle it.
    if (memory.pendingContinue) return
    // Model active recently (busy/retry within the last 60s) — don't interrupt.
    if (memory.lastBusyAt && Date.now() - memory.lastBusyAt < 60_000) return
    // User just sent a real message — respect the grace window.
    if (memory.lastUserMessageAt && Date.now() - memory.lastUserMessageAt < cfg.userGraceMs) return
    // Task genuinely done — stop the heartbeat, don't inject.
    const matcher = buildCompletionMatcher(cfg)
    if (matcher) {
      try {
        const latestText = await this.latestAssistantText(sessionID)
        if (hasCompletionMarker(latestText, matcher)) {
          this.stopKeepAlive(sessionID)
          return
        }
      } catch {
        // Proceed on context-read failure (defensive).
      }
    }
    try {
      await injectContinuation(this.session, sessionID, cfg.intervalMessage, entry.endAt ?? 0)
    } catch (error) {
      console.error("[opencode-autocontinue] keep-alive injection failed:", error)
    }
  }

  /** Core injection decision. Idempotent per session (single-flight via inFlight). */
  private async tryInject(sessionID: string): Promise<void> {
    const cfg = this.config()
    const memory = this.store.getMemory(sessionID)
    if (this.disposed || !cfg.enabled) return
    if (memory.inFlight) return
    // 入口即置位：后面有多个 await（标题、最新消息），并发 tryInject 才能被拦住。
    memory.inFlight = true
    try {
      const entry = this.store.getState(sessionID)
      if (!entry || entry.state !== "watching") return

      // Time window (endAt frozen at watch time).
      if (startTimeNotReached(cfg.startTime)) return
      if (entry.endAt && Date.now() >= entry.endAt) {
        await this.store.markStopped(sessionID)
        this.clearTimer(sessionID)
        this.stopKeepAlive(sessionID)
        void this.emitChangedInternal(sessionID, "stopped")
        return
      }

      // Consecutive cap.
      if (cfg.maxConsecutive > 0 && entry.consecutive >= cfg.maxConsecutive) {
        await this.store.markStopped(sessionID)
        this.clearTimer(sessionID)
        this.stopKeepAlive(sessionID)
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
        this.stopKeepAlive(sessionID)
        void this.emitChangedInternal(sessionID, "stopped")
        return
      }

      // Min interval between injections.
      if (entry.lastInjectedAt && Date.now() - entry.lastInjectedAt < cfg.minIntervalMs) {
        const remaining = cfg.minIntervalMs - (Date.now() - entry.lastInjectedAt)
        this.scheduleInjection(sessionID, remaining + 100)
        return
      }

      // Check for completion marker in the latest assistant message before injecting.
      const matcher = buildCompletionMatcher(cfg)
      if (matcher) {
        const latestText = await this.latestAssistantText(sessionID)
        if (hasCompletionMarker(latestText, matcher)) {
          await this.store.markDone(sessionID)
          this.clearTimer(sessionID)
          this.stopKeepAlive(sessionID)
          void this.emitChangedInternal(sessionID, "done")
          return
        }
      }

      // 注入前复查：上面 await 期间 session 可能已被 unwatch / markDone / markStopped。
      const freshEntry = this.store.getState(sessionID)
      if (!freshEntry || freshEntry.state !== "watching") return

      await injectContinuation(this.session, sessionID, cfg.message, freshEntry.endAt ?? 0)
      await this.store.recordInjection(sessionID)
      void this.emitChangedInternal(sessionID, "watching")
    } catch (error) {
      console.error("[opencode-autocontinue] injection failed:", error)
    } finally {
      memory.inFlight = false
    }
  }

    private async latestAssistantText(sessionID: string): Promise<string> {
    try {
      const messages = (await this.session.context({ sessionID })) as Array<{
        info?: { role?: string }
        parts?: unknown
      }>
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message.info?.role === "assistant") {
          return messageText(message.parts)
        }
      }
    } catch {
      // Fall through to empty.
    }
    return ""
  }

  private async resolveTitle(sessionID: string): Promise<string | undefined> {
    if (this.titleCache.has(sessionID)) return this.titleCache.get(sessionID)
    try {
      const messages = (await this.session.context({ sessionID })) as Array<{
        info?: { role?: string; title?: string }
      }>
      const title = messages.find((message) => typeof message.info?.title === "string")?.info?.title
      this.titleCache.set(sessionID, title ?? "")
      return title
    } catch {
      return undefined
    }
  }

  private async emitChangedInternal(sessionID: string, state: WatchState["state"]): Promise<void> {
    const entry = this.store.getState(sessionID)
    this.emitChanged(sessionID, state, entry?.consecutive ?? 0)
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
        const status = (event.properties?.status ?? event.status) as { type?: string } | string | undefined
        const statusType = typeof status === "string" ? status : status?.type
        if (statusType === "busy" || statusType === "retry") {
          memory.lastBusyAt = Date.now()
        }
        break
      }
      case "session.error": {
        const error = event.properties?.error ?? event.error
        if (isRetryableError(error, cfg.errorPatterns, cfg.excludePatterns)) {
          memory.pendingContinue = true
        }
        break
      }
      case "session.idle": {
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
      case "message.updated": {
        const info = event.properties?.info
        if (!info || typeof info !== "object") break
        const role = (info as { role?: string }).role
        if (role === "user") {
          memory.lastUserMessageAt = Date.now()
          await this.store.resume(sessionID)
          this.scheduleKeepAlive(sessionID)
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
          if (messageID) {
            const matcher = buildCompletionMatcher(cfg)
            if (matcher) {
              const text = await this.latestAssistantText(sessionID)
              if (hasCompletionMarker(text, matcher)) {
                await this.store.markDone(sessionID)
                this.clearTimer(sessionID)
                this.stopKeepAlive(sessionID)
                void this.emitChangedInternal(sessionID, "done")
              }
            }
          }
        }
        break
      }
      case "session.deleted": {
        this.store.unwatch(sessionID).catch(() => {})
        this.clearTimer(sessionID)
        this.stopKeepAlive(sessionID)
        break
      }
      default:
        break
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const timer of this.intervalTimers.values()) clearInterval(timer)
    this.intervalTimers.clear()
  }
}
