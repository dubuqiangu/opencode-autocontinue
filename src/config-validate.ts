// Merge and per-key validation of the plugin config.
//
// A raw config object is layered over a base PluginConfig; every rewritten
// value is reported exactly once on stderr.

import {
  CONFIG_KEY_TYPES,
  DEFAULT_CONFIG,
  MAX_MARKER_REGEX_SOURCE_LENGTH,
  MAX_TIMER_DELAY_MS,
  MAX_VERIFY_ITERATIONS,
  MAX_VERIFY_TIMEOUT_MS,
  MIN_PERIODIC_INTERVAL_MS,
  MIN_VERIFY_TIMEOUT_MS,
  errorMessage,
} from "./config-schema.ts"
import type { PluginConfig } from "./config-schema.ts"

// Keep only the usable entries of a config array: strings that are not empty.
// A blank entry is never useful — "" is a substring of every string, so an
// empty pattern would match every error and an empty marker every message.
//
// Dropping an entry rewrites the user's array, so the rewrite is reported
// exactly once per key: the report names the key, counts the dropped blank
// and non-string entries and says whether any usable entry is left.
function usableStringList(entries: unknown[], keyName: string): string[] {
  const usableEntries = entries.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  )
  const blankCount = entries.filter((entry) => entry === "").length
  const nonStringCount = entries.filter((entry) => typeof entry !== "string").length
  if (blankCount === 0 && nonStringCount === 0) return usableEntries
  const droppedSummary = `removed ${blankCount} blank ${blankCount === 1 ? "entry" : "entries"} and ${nonStringCount} non-string ${nonStringCount === 1 ? "entry" : "entries"}`
  if (usableEntries.length === 0) {
    console.error(
      `[opencode-autocontinue] dropped unusable entries from config "${keyName}": ${droppedSummary}, the key now has no usable entries`,
    )
  } else {
    console.error(
      `[opencode-autocontinue] dropped unusable entries from config "${keyName}": ${droppedSummary}, ${usableEntries.length} usable ${usableEntries.length === 1 ? "entry" : "entries"} left`,
    )
  }
  return usableEntries
}

// Validate an HH:MM local clock value. An empty string disables the window.
// Anything else must match ^\d{1,2}:\d{2}$ with hour <= 23 and minute <= 59;
// an invalid value is reported once and falls back to "no window".
function validatedClockTime(value: string, keyName: string): string {
  if (value === "") return value
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  const hours = match ? Number(match[1]) : Number.NaN
  const minutes = match ? Number(match[2]) : Number.NaN
  if (!match || hours > 23 || minutes > 59) {
    console.error(
      `[opencode-autocontinue] ignored invalid config "${keyName}": expected HH:MM (00:00-23:59), got ${JSON.stringify(value)}`,
    )
    return ""
  }
  return value
}

// Report a config value that the merge layer rewrote. Every rewrite is
// reported exactly once, and the message names the key, the original value
// and the value that actually takes effect.
function reportClampedConfig(
  keyName: string,
  originalValue: number,
  effectiveValue: number,
  reason: string,
): void {
  console.error(
    `[opencode-autocontinue] clamped config "${keyName}": ${originalValue} ${reason}, using ${effectiveValue}`,
  )
}

// Clamp a delay (ms) into the safe timer range: a negative delay would cancel
// the guardrail it belongs to, and a delay beyond the 32 bit timer ceiling
// overflows and fires immediately. A rewritten value is reported once.
function clampedTimerDelay(value: number, keyName: string): number {
  if (value > MAX_TIMER_DELAY_MS) {
    reportClampedConfig(
      keyName,
      value,
      MAX_TIMER_DELAY_MS,
      `exceeds the maximum timer delay of ${MAX_TIMER_DELAY_MS} ms`,
    )
    return MAX_TIMER_DELAY_MS
  }
  if (value < 0) {
    reportClampedConfig(keyName, value, 0, "is negative")
    return 0
  }
  return value
}

// Clamp a duration (ms) that may not be negative. 0 keeps its documented
// meaning ("do not wait" / "no limit"), so only a negative value is rewritten —
// and such a rewrite is reported once.
function clampedNonNegativeDuration(value: number, keyName: string): number {
  if (value < 0) {
    reportClampedConfig(keyName, value, 0, "is negative")
    return 0
  }
  return value
}

// Clamp the periodic check interval (ms). 0 means "periodic checks disabled"
// and is kept as-is; a positive value below the anti-spam floor is raised to
// that floor; a negative value is clamped to 0; a value beyond the timer
// ceiling is clamped down to it. Every rewrite is reported once.
function clampedInterval(value: number, keyName: string): number {
  if (value === 0) return 0
  if (value < 0) {
    reportClampedConfig(keyName, value, 0, "is negative")
    return 0
  }
  if (value < MIN_PERIODIC_INTERVAL_MS) {
    reportClampedConfig(
      keyName,
      value,
      MIN_PERIODIC_INTERVAL_MS,
      `is below the ${MIN_PERIODIC_INTERVAL_MS} ms floor`,
    )
    return MIN_PERIODIC_INTERVAL_MS
  }
  return clampedTimerDelay(value, keyName)
}

// Clamp the per-run verification timeout (ms) into 1s..3600s. Every rewrite
// is reported once.
function clampedVerifyTimeout(value: number, keyName: string): number {
  if (value < MIN_VERIFY_TIMEOUT_MS) {
    reportClampedConfig(
      keyName,
      value,
      MIN_VERIFY_TIMEOUT_MS,
      `is below the ${MIN_VERIFY_TIMEOUT_MS} ms floor`,
    )
    return MIN_VERIFY_TIMEOUT_MS
  }
  if (value > MAX_VERIFY_TIMEOUT_MS) {
    reportClampedConfig(
      keyName,
      value,
      MAX_VERIFY_TIMEOUT_MS,
      `exceeds the maximum of ${MAX_VERIFY_TIMEOUT_MS} ms`,
    )
    return MAX_VERIFY_TIMEOUT_MS
  }
  return value
}

// Clamp the number of failing verification rounds into 0..10000 (0 = unlimited).
// Every rewrite is reported once.
function clampedVerifyIterations(value: number, keyName: string): number {
  if (value < 0) {
    reportClampedConfig(keyName, value, 0, "is negative")
    return 0
  }
  if (value > MAX_VERIFY_ITERATIONS) {
    reportClampedConfig(
      keyName,
      value,
      MAX_VERIFY_ITERATIONS,
      `exceeds the maximum of ${MAX_VERIFY_ITERATIONS}`,
    )
    return MAX_VERIFY_ITERATIONS
  }
  return value
}

/** Render a config value for a diagnostic message. Strings are quoted so a
 *  numeric-looking string stays distinguishable from a number; NaN and
 *  Infinity print as-is (JSON.stringify would turn them into "null"). */
function describeConfigValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return String(value)
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  try {
    const serializedValue = JSON.stringify(value)
    return serializedValue === undefined ? String(value) : serializedValue
  } catch {
    return String(value)
  }
}

/** Report an override that cannot take effect. Exactly one message per key,
 *  naming the key, the value the user wrote and the value that stays in
 *  effect. */
function reportIgnoredOverride(
  keyName: string,
  originalValue: unknown,
  effectiveValue: unknown,
  expectation: string,
): void {
  console.error(
    `[opencode-autocontinue] ignored invalid config "${keyName}": expected ${expectation}, got ${describeConfigValue(originalValue)}; using ${describeConfigValue(effectiveValue)} instead`,
  )
}

export function mergeConfig(base: PluginConfig, raw: unknown): PluginConfig {
  if (raw === null || raw === undefined) return { ...base }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    const describedRaw = Array.isArray(raw) ? "an array" : describeConfigValue(raw)
    console.error(
      `[opencode-autocontinue] ignored invalid config file: expected a configuration object, got ${describedRaw}; using the previous configuration instead`,
    )
    return { ...base }
  }
  const rawPrototype = Object.getPrototypeOf(raw)
  if (rawPrototype !== Object.prototype && rawPrototype !== null) {
    console.error(
      `[opencode-autocontinue] ignored invalid config file: expected a configuration object, got ${describeConfigValue(raw)}; using the previous configuration instead`,
    )
    return { ...base }
  }
  const overrides = raw as Record<string, unknown>
  const merged: PluginConfig = { ...base }
  const effectiveValues = base as unknown as Record<string, unknown>
  for (const [keyName, expectedType] of Object.entries(CONFIG_KEY_TYPES)) {
    const originalValue = overrides[keyName]
    if (originalValue === undefined) continue
    const expectation = expectedType === "boolean"
      ? "a boolean"
      : expectedType === "number"
        ? "a number"
        : expectedType === "string"
          ? "a string"
          : expectedType === "nonEmptyString"
            ? "a non-empty string"
            : "an array of strings"
    const hasExpectedType = expectedType === "boolean"
      ? typeof originalValue === "boolean"
      : expectedType === "number"
        ? typeof originalValue === "number"
        : expectedType === "string"
          ? typeof originalValue === "string"
          : expectedType === "nonEmptyString"
            ? typeof originalValue === "string" && originalValue.length > 0
            : Array.isArray(originalValue)
    if (hasExpectedType) {
      if (expectedType === "number" && !Number.isFinite(originalValue)) {
        reportIgnoredOverride(keyName, originalValue, effectiveValues[keyName], "a finite number")
      }
      continue
    }
    reportIgnoredOverride(keyName, originalValue, effectiveValues[keyName], expectation)
  }
  if (typeof overrides.enabled === "boolean") merged.enabled = overrides.enabled
  if (typeof overrides.message === "string" && overrides.message) merged.message = overrides.message
  if (typeof overrides.startTime === "string") {
    merged.startTime = validatedClockTime(overrides.startTime, "startTime")
  }
  if (typeof overrides.endTime === "string") {
    merged.endTime = validatedClockTime(overrides.endTime, "endTime")
  }
  if (typeof overrides.idleDelayMs === "number" && Number.isFinite(overrides.idleDelayMs)) {
    merged.idleDelayMs = clampedTimerDelay(overrides.idleDelayMs, "idleDelayMs")
  }
  if (typeof overrides.minIntervalMs === "number" && Number.isFinite(overrides.minIntervalMs)) {
    merged.minIntervalMs = clampedTimerDelay(overrides.minIntervalMs, "minIntervalMs")
  }
  if (typeof overrides.maxConsecutive === "number" && Number.isFinite(overrides.maxConsecutive)) {
    if (overrides.maxConsecutive >= 0) {
      merged.maxConsecutive = overrides.maxConsecutive
    } else {
      // A negative cap is almost certainly a typo: the engine only enforces the
      // limit when `maxConsecutive > 0`, so a negative value would silently
      // cancel the only injection ceiling. Fall back to the base value, and to
      // the shipped default when the base value is unusable as well.
      const fallbackCap =
        Number.isFinite(base.maxConsecutive) && base.maxConsecutive >= 0
          ? base.maxConsecutive
          : DEFAULT_CONFIG.maxConsecutive
      reportClampedConfig("maxConsecutive", overrides.maxConsecutive, fallbackCap, "is negative")
      merged.maxConsecutive = fallbackCap
    }
  }
  if (typeof overrides.watchTimeoutMs === "number" && Number.isFinite(overrides.watchTimeoutMs)) {
    // 0 keeps its meaning ("no time limit"); only negatives are clamped away.
    merged.watchTimeoutMs = clampedNonNegativeDuration(overrides.watchTimeoutMs, "watchTimeoutMs")
  }
  if (Array.isArray(overrides.completionMarkers)) {
    merged.completionMarkers = usableStringList(overrides.completionMarkers, "completionMarkers")
  }
  if (typeof overrides.markerRegex === "string") {
    const markerRegexSource = overrides.markerRegex
    if (markerRegexSource.length > MAX_MARKER_REGEX_SOURCE_LENGTH) {
      console.error(
        `[opencode-autocontinue] ignored invalid config "markerRegex": source is longer than ${MAX_MARKER_REGEX_SOURCE_LENGTH} characters`,
      )
    } else if (/\([^)]*[+*]\)[+*]/.test(markerRegexSource)) {
      console.error(
        `[opencode-autocontinue] ignored invalid config "markerRegex": nested quantifiers may cause catastrophic backtracking (ReDoS)`,
      )
    } else {
      try {
        new RegExp(markerRegexSource, "i")
        merged.markerRegex = markerRegexSource
      } catch (error) {
        console.error(
          `[opencode-autocontinue] ignored invalid config "markerRegex": ${errorMessage(error)}`,
        )
      }
    }
  }
  if (typeof overrides.finalCheckEnabled === "boolean") merged.finalCheckEnabled = overrides.finalCheckEnabled
  if (typeof overrides.finalCheckMessage === "string" && overrides.finalCheckMessage) {
    merged.finalCheckMessage = overrides.finalCheckMessage
  }
  if (Array.isArray(overrides.errorPatterns)) {
    merged.errorPatterns = usableStringList(overrides.errorPatterns, "errorPatterns")
  }
  if (Array.isArray(overrides.excludePatterns)) {
    merged.excludePatterns = usableStringList(overrides.excludePatterns, "excludePatterns")
  }
  if (Array.isArray(overrides.excludeTitleKeywords)) {
    merged.excludeTitleKeywords = usableStringList(overrides.excludeTitleKeywords, "excludeTitleKeywords")
  }
  if (typeof overrides.userGraceMs === "number" && Number.isFinite(overrides.userGraceMs)) {
    // 0 keeps its meaning ("do not wait"); only negatives are clamped away.
    merged.userGraceMs = clampedNonNegativeDuration(overrides.userGraceMs, "userGraceMs")
  }
  // intervalMs: 0 means periodic checks disabled (scheduleInterval honors <=0).
  // Preserve the P2-7 anti-spam floor (min 1s) only for positive values, so the
  // documented "0 = disabled" escape hatch is actually reachable via config.
  if (typeof overrides.intervalMs === "number" && Number.isFinite(overrides.intervalMs)) {
    merged.intervalMs = clampedInterval(overrides.intervalMs, "intervalMs")
  }
  if (typeof overrides.verifyCommand === "string") merged.verifyCommand = overrides.verifyCommand
  if (typeof overrides.verifyTimeoutMs === "number" && Number.isFinite(overrides.verifyTimeoutMs)) {
    // Clamp 1s..3600s (对齐 dsh-pua configuration.ts:21-32).
    merged.verifyTimeoutMs = clampedVerifyTimeout(overrides.verifyTimeoutMs, "verifyTimeoutMs")
  }
  if (typeof overrides.verifyMaxIterations === "number" && Number.isFinite(overrides.verifyMaxIterations)) {
    // Clamp 0..10000 (0 = unlimited).
    merged.verifyMaxIterations = clampedVerifyIterations(overrides.verifyMaxIterations, "verifyMaxIterations")
  }
  if (typeof overrides.verifyCwd === "string") merged.verifyCwd = overrides.verifyCwd
  if (typeof overrides.selfEchoWindowMs === "number" && Number.isFinite(overrides.selfEchoWindowMs)) {
    merged.selfEchoWindowMs = clampedNonNegativeDuration(overrides.selfEchoWindowMs, "selfEchoWindowMs")
  }
  // Sentinel tags accept any string, including "" (which disables the sentinel).
  if (typeof overrides.abortSentinelTag === "string") merged.abortSentinelTag = overrides.abortSentinelTag
  if (typeof overrides.pauseSentinelTag === "string") merged.pauseSentinelTag = overrides.pauseSentinelTag
  if (typeof overrides.escalationReassessMessage === "string") {
    merged.escalationReassessMessage = overrides.escalationReassessMessage
  }
  if (typeof overrides.escalationRootCauseMessage === "string") {
    merged.escalationRootCauseMessage = overrides.escalationRootCauseMessage
  }
  // A provided array replaces the default (never concatenated); an explicit
  // empty array is honored so `escalationPressureLadder: []` disables the line.
  if (Array.isArray(overrides.escalationPressureLadder)) {
    merged.escalationPressureLadder = usableStringList(overrides.escalationPressureLadder, "escalationPressureLadder")
  }
  if (typeof overrides.observeToolFailures === "boolean") merged.observeToolFailures = overrides.observeToolFailures
  // P2: the trigger list REPLACES the default (never concatenated) and an
  // explicit [] disables the frustration path. Blank entries are dropped.
  if (Array.isArray(overrides.frustrationTriggers)) {
    merged.frustrationTriggers = usableStringList(overrides.frustrationTriggers, "frustrationTriggers")
  }
  if (typeof overrides.frustrationMessage === "string") {
    merged.frustrationMessage = overrides.frustrationMessage
  }
  return merged
}
