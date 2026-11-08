// Pure TUI logic for opencode-autocontinue (unit-testable, no JSX).
//
// Extracted from src/tui.tsx: the stop-reason label map, the duration
// formatter and the `state.changed` merge rule used to live inside the .tsx
// file, where they could only be exercised by scraping the source text
// (see test/tui-delivery.test.ts). This module has NO JSX, NO solid-js
// import and NO host SDK dependency — the test suite can import it directly
// (node --experimental-strip-types --test).

/** Per-session watch status as rendered by the footer indicator and the
 *  right-sidebar Watch block. */
export interface WatchStatusView {
  sessionID: string
  state: "watching" | "confirming" | "stopped" | "paused" | "done"
  injections: number
  /** Lifetime injections for this watch (never reset by user turns). */
  totalInjections?: number
  lastInjectedAt?: number
  /** Epoch ms when watching started for this session (drives the sidebar timer). */
  since?: number
  /** Failing verification rounds in the current round (verify-driven loop). */
  rejections?: number
  /** True while a verification command is in flight for this session. */
  verifying?: boolean
  /** Observed distinct tool failures in the current round (opt-in, display only). */
  toolFailureCount?: number
  /** Why the round stopped (only present while state is "stopped"). */
  stopReason?: string
}

/** The fields of a `state.changed` event that the TUI merges into its local
 *  per-session view. `state` stays a plain string because the event payload
 *  is untyped at the RPC boundary — unknown values are ignored by the merge. */
export interface WatchStateChanged {
  sessionID: string
  state: string
  injections: number
  totalInjections?: number
  rejections?: number
  verifying?: boolean
  toolFailureCount?: number
  stopReason?: string
}

/** Human-readable phrases for the stop reasons reported by the server.
 *  The TUI copy is English, so these phrases follow the same convention.
 *  Unknown / missing reasons map to undefined so the caller can omit the
 *  suffix entirely. */
export const STOP_REASON_LABELS: Record<string, string> = {
  "window-closed": "window closed",
  "watch-timeout": "watch timeout",
  "injection-cap": "injection cap",
  "verify-limit": "verify limit",
  "idle-interrupted": "interrupted while idle",
  "user-interrupted": "stopped by user",
  "abort-sentinel": "abort sentinel",
  "title-excluded": "title excluded",
}

/** Short human-readable phrase for a stop reason, or undefined when there is
 *  none (e.g. the user unwatched the session). */
export function stopReasonLabel(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  // Own-property check on purpose: `STOP_REASON_LABELS` is a plain object
  // literal, so a bare `STOP_REASON_LABELS["constructor"]` hits
  // `Object.prototype` and turns the footer suffix into
  // "· function Object() { [native code] }". The reason string arrives
  // untyped from the event payload, so it is not worth trusting to be a
  // harmless key.
  if (!Object.hasOwn(STOP_REASON_LABELS, reason)) return undefined
  return STOP_REASON_LABELS[reason]
}

/** Short human-readable labels for the watch states the TUI surfaces.
 *
 *  The protocol values are internal and never reach the user as-is: a bare
 *  enum tells the user nothing about what the plugin is doing right now.
 *  The labels follow the TUI's English, lowercase style (see the sidebar rows
 *  "verifying" / "rejections" / "tool failures").
 *
 *  - the plain watching state → "on watch"    — 值守中，等着任务中断或完成标记
 *  - the review state         → "review round" — 复查轮：完成标记已命中，
 *                                     注入了复查话术，正在等用户的复查回复
 */
export const WATCH_STATE_LABELS: Record<string, string> = {
  watching: "on watch",
  confirming: "review round",
  paused: "on hold",
  stopped: "stopped",
  done: "finished",
}

/** Short human-readable label for a watch state.
 *
 *  Unknown states (a newer server announcing a state this TUI build does not
 *  know yet) fall back to a visibly raw value — never to an empty string, so
 *  the sidebar row and the status toast always say something.
 *
 *  The lookup is an own-property check on purpose: `WATCH_STATE_LABELS` is a
 *  plain object literal, so a bare `WATCH_STATE_LABELS["constructor"]` hits
 *  `Object.prototype` and renders "function Object() { [native code] }"
 *  instead of falling back. The state string arrives untyped from the RPC
 *  boundary, so it is not worth trusting to be a harmless key. */
export function watchStateLabel(state: string): string {
  if (!Object.hasOwn(WATCH_STATE_LABELS, state)) return `unknown state (${state})`
  return WATCH_STATE_LABELS[state]
}

// "3m 22s" (≥1 min) or "45s"; "10h 13m" (≥1h); "2d 3h" (≥1d).
// Clamps negative/NaN inputs to "0s".
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** True for the state values the TUI knows how to render. */
function isWatchState(state: string): state is WatchStatusView["state"] {
  return (
    state === "watching" ||
    state === "confirming" ||
    state === "stopped" ||
    state === "paused" ||
    state === "done"
  )
}

/**
 * Merge a `state.changed` event into the current per-session view.
 *
 * Rules (identical to the inline logic this function replaces):
 *  - An active / terminal-but-live round (watching, confirming, paused, done)
 *    carries no stop reason: any stale `stopReason` left over from an earlier
 *    stopped round is dropped, so the footer never pairs a live round with a
 *    dead round's phrase.
 *  - A stopped round carries its reason in the event; the phrase is merged
 *    immediately so the footer can render it without waiting for the RPC
 *    round-trip.
 *  - A stopped round WITHOUT a reason (a plain user unwatch) carries nothing
 *    to merge — the caller re-checks the server state instead. The same holds
 *    for an unknown state value: nothing is merged.
 *
 * Returns undefined when there is nothing to merge (the caller must then keep
 * the current view untouched).
 */
export function mergeWatchState(
  current: WatchStatusView | undefined,
  change: WatchStateChanged,
): WatchStatusView | undefined {
  const state = change.state
  if (!isWatchState(state)) return undefined
  // A stopped round without a reason is a user unwatch, not a guardrail stop:
  // there is nothing local to merge, the RPC status re-check decides.
  if (state === "stopped" && typeof change.stopReason !== "string") return undefined
  const merged: WatchStatusView = {
    // Keep the fields the event does not carry (`since`, `lastInjectedAt`):
    // dropping `since` would freeze the sidebar ⏱ to its "starting" state.
    ...(current ?? {}),
    sessionID: change.sessionID,
    state,
    injections: change.injections,
    ...(typeof change.totalInjections === "number" ? { totalInjections: change.totalInjections } : {}),
    ...(typeof change.rejections === "number" ? { rejections: change.rejections } : {}),
    ...(typeof change.verifying === "boolean" ? { verifying: change.verifying } : {}),
    ...(typeof change.toolFailureCount === "number" ? { toolFailureCount: change.toolFailureCount } : {}),
    // A live / done round carries no stop reason — drop any stale one left
    // over from an earlier stopped round.
    stopReason: state === "stopped" ? change.stopReason : undefined,
  }
  return merged
}
