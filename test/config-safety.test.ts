// Safety tests for the config merge layer of src/config.ts: numeric clamps,
// clock windows, the markerRegex guardrails and the string-list sanitizing.
// Every value the merge layer rewrites is reported exactly once, and a value
// that is already legal is never reported.
//
// The JSONC parser has its own file: test/config-parse.test.ts
// Run: node --experimental-strip-types --test test/config-safety.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG, mergeConfig, buildCompletionMatcher, type PluginConfig } from "../src/config.ts"

/** The string list keys of the config that are sanitized by the merge layer. */
const STRING_LIST_KEYS = ["completionMarkers", "errorPatterns", "excludePatterns", "excludeTitleKeywords", "escalationPressureLadder", "frustrationTriggers"] as const

/** Merge `overrides` over `base` with console.error captured; returns the
 *  merged config and the collected error messages (console.error is always
 *  restored). */
function mergeWithDiagnostics(overrides: Record<string, unknown>, base: PluginConfig = DEFAULT_CONFIG) {
  const messages: string[] = []
  const originalError = console.error
  console.error = (...errorArguments: unknown[]) => messages.push(errorArguments.map((argument) => String(argument)).join(" "))
  try {
    return { result: mergeConfig(base, overrides), messages }
  } finally {
    console.error = originalError
  }
}

/** Assert that the entries dropped from the string list `keyName` are
 *  reported exactly once and that the usable entries survive. */
function assertDroppedEntriesReported(keyName: string, overrides: Record<string, unknown>, expected: string[]) {
  const { result, messages } = mergeWithDiagnostics(overrides)
  const merged = result as unknown as Record<string, unknown>
  assert.deepEqual(merged[keyName], expected, `${keyName} must keep its usable entries`)
  assert.equal(messages.length, 1, `${keyName} must produce exactly one diagnostic`)
  assert.ok(messages[0].includes(keyName) && messages[0].includes("1 blank entry"), `the report must name ${keyName} and count its blank entries`)
}

// --- F4: non-finite numeric overrides fall back to the base value ---

test("mergeConfig falls back to defaults for non-finite numeric overrides", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    idleDelayMs: 1e400, minIntervalMs: -1e400, maxConsecutive: 1e400, userGraceMs: 1e400, intervalMs: 1e400, watchTimeoutMs: 1e400,
    selfEchoWindowMs: 1e400, verifyTimeoutMs: 1e400, verifyMaxIterations: 1e400,
  })
  for (const keyName of ["idleDelayMs", "minIntervalMs", "maxConsecutive", "userGraceMs", "intervalMs", "watchTimeoutMs", "selfEchoWindowMs", "verifyTimeoutMs", "verifyMaxIterations"] as const) {
    assert.equal(merged[keyName], DEFAULT_CONFIG[keyName], `${keyName} must fall back to the default`)
  }
})

test("mergeConfig falls back to defaults for NaN numeric overrides", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { idleDelayMs: Number.NaN, verifyTimeoutMs: Number.NaN, verifyMaxIterations: Number.NaN })
  assert.equal(merged.idleDelayMs, DEFAULT_CONFIG.idleDelayMs)
  assert.equal(merged.verifyTimeoutMs, DEFAULT_CONFIG.verifyTimeoutMs)
  assert.equal(merged.verifyMaxIterations, DEFAULT_CONFIG.verifyMaxIterations)
})

test("mergeConfig still applies a finite numeric override", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { idleDelayMs: 5_000, verifyTimeoutMs: 45_000 })
  assert.equal(merged.idleDelayMs, 5_000)
  assert.equal(merged.verifyTimeoutMs, 45_000)
})

test("mergeConfig keeps existing clamp bounds for finite values", () => {
  const lowerBounds = mergeWithDiagnostics({ verifyTimeoutMs: 10, verifyMaxIterations: -3 })
  assert.equal(lowerBounds.result.verifyTimeoutMs, 1_000)
  assert.equal(lowerBounds.result.verifyMaxIterations, 0)
  assert.equal(lowerBounds.messages.length, 2, "every clamped key must produce exactly one diagnostic")

  const upperBounds = mergeWithDiagnostics({ verifyTimeoutMs: 9_999_999, verifyMaxIterations: 99_999 })
  assert.equal(upperBounds.result.verifyTimeoutMs, 3_600_000)
  assert.equal(upperBounds.result.verifyMaxIterations, 10_000)
  assert.equal(upperBounds.messages.length, 2, "every clamped key must produce exactly one diagnostic")
})

// --- P3: unattended guardrail defaults ---

test("the watch budget and verification cap have finite defaults", () => {
  assert.equal(DEFAULT_CONFIG.watchTimeoutMs, 86_400_000)
  assert.equal(DEFAULT_CONFIG.verifyMaxIterations, 50)
})

test("an explicit 0 still means unlimited for the watch budget and the verify cap", () => {
  // The > 0 guards in the engine keep 0 as "no limit"; merging must not turn
  // it into the default bound.
  const merged = mergeConfig(DEFAULT_CONFIG, { watchTimeoutMs: 0, verifyMaxIterations: 0 })
  assert.equal(merged.watchTimeoutMs, 0)
  assert.equal(merged.verifyMaxIterations, 0)
})

test("a non-finite watch budget or verify cap falls back to the new defaults", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { watchTimeoutMs: Number.POSITIVE_INFINITY, verifyMaxIterations: Number.NaN })
  assert.equal(merged.watchTimeoutMs, DEFAULT_CONFIG.watchTimeoutMs)
  assert.equal(merged.verifyMaxIterations, DEFAULT_CONFIG.verifyMaxIterations)
})

// --- P2: frustration trigger merging ---

test("the frustration trigger list is off by default and its message has the spec text", () => {
  assert.deepEqual(DEFAULT_CONFIG.frustrationTriggers, [])
  assert.equal(DEFAULT_CONFIG.frustrationMessage, "用户明确表达了对质量的不满：换本质不同的方法重新推进，并贴出可核对的验证证据（命令 + 输出），不要只改措辞。")
})

test("mergeConfig replaces the frustration trigger list and drops blank entries", () => {
  const { result, messages } = mergeWithDiagnostics({ frustrationTriggers: ["不满意", "", "太差了", 42, null] })
  // The provided array REPLACES the default (never concatenated) and only
  // non-empty strings survive.
  assert.deepEqual(result.frustrationTriggers, ["不满意", "太差了"])
  assert.equal(messages.length, 1, "the dropped entries must be reported exactly once")
  assert.ok(messages[0].includes("frustrationTriggers"), "the report must name the key")
  assert.ok(messages[0].includes("1 blank entry"), "the report must count the blank entries")
  assert.ok(messages[0].includes("2 non-string entries"), "the report must count the non-string entries")
})

test("mergeConfig honors an explicit empty frustration trigger list (feature off)", () => {
  const merged = mergeConfig({ ...DEFAULT_CONFIG, frustrationTriggers: ["不满意"] }, { frustrationTriggers: [] })
  assert.deepEqual(merged.frustrationTriggers, [])
})

test("mergeConfig ignores a non-array frustration trigger override", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { frustrationTriggers: "不满意" })
  assert.deepEqual(merged.frustrationTriggers, [])
})

test("mergeConfig overrides the frustration message with a string only", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { frustrationMessage: "换个方法" }).frustrationMessage, "换个方法")
  assert.equal(mergeConfig(DEFAULT_CONFIG, { frustrationMessage: 42 }).frustrationMessage, DEFAULT_CONFIG.frustrationMessage)
})

// --- A2: mergeConfig validation layer ---

test("mergeConfig drops blank entries from every string list override", () => {
  const { result, messages } = mergeWithDiagnostics({
    completionMarkers: ["", "X"], errorPatterns: ["", "X"], excludePatterns: ["", "X"], excludeTitleKeywords: ["", "X"], escalationPressureLadder: ["", "X"],
    frustrationTriggers: ["", "X"],
  })
  const merged = result as unknown as Record<string, unknown>
  assert.equal(messages.length, 6, "every rewritten key must produce exactly one diagnostic")
  for (const keyName of STRING_LIST_KEYS) {
    assert.deepEqual(merged[keyName], ["X"], `${keyName} must keep its usable entries`)
    const message = messages.find((entry) => entry.includes(`"${keyName}"`))
    assert.ok(message, `the diagnostic must name ${keyName}`)
    assert.ok(message.includes("1 blank entry"), `the diagnostic must count the blank entries of ${keyName}`)
  }
})

test("mergeConfig honors an explicitly empty string list override", () => {
  const { result, messages } = mergeWithDiagnostics({
    completionMarkers: [], errorPatterns: [], excludePatterns: [], excludeTitleKeywords: [], escalationPressureLadder: [], frustrationTriggers: [],
  })
  const merged = result as unknown as Record<string, unknown>
  for (const keyName of STRING_LIST_KEYS) {
    assert.deepEqual(merged[keyName], [], `${keyName} must stay empty`)
  }
  assert.deepEqual(messages, [], "an empty list is a legal value and must not be reported")
})

test("mergeConfig reports a blank completion marker and keeps the usable ones", () => {
  assertDroppedEntriesReported("completionMarkers", { completionMarkers: ["", "X"] }, ["X"])
})

test("mergeConfig reports a blank error pattern and keeps the usable ones", () => {
  assertDroppedEntriesReported("errorPatterns", { errorPatterns: ["", "X"] }, ["X"])
})

test("mergeConfig reports a blank exclude pattern and keeps the usable ones", () => {
  assertDroppedEntriesReported("excludePatterns", { excludePatterns: ["", "X"] }, ["X"])
})

test("mergeConfig reports a blank title keyword and keeps the usable ones", () => {
  assertDroppedEntriesReported("excludeTitleKeywords", { excludeTitleKeywords: ["", "X"] }, ["X"])
})

test("mergeConfig reports a blank escalation ladder row and keeps the usable ones", () => {
  assertDroppedEntriesReported("escalationPressureLadder", { escalationPressureLadder: ["", "X"] }, ["X"])
})

test("mergeConfig reports a blank frustration trigger and keeps the usable ones", () => {
  assertDroppedEntriesReported("frustrationTriggers", { frustrationTriggers: ["", "X"] }, ["X"])
})

test("mergeConfig reports a string list that ended up without any usable entry", () => {
  const { result, messages } = mergeWithDiagnostics({ completionMarkers: [""] })
  assert.deepEqual(result.completionMarkers, [])
  assert.equal(messages.length, 1, "the dropped entry must be reported exactly once")
  assert.ok(messages[0].includes("completionMarkers"), "the report must name the key")
  assert.ok(messages[0].includes("no usable entries"), "the report must say that nothing is left")
})

test("mergeConfig reports nothing for a string list without blank entries", () => {
  const { result, messages } = mergeWithDiagnostics({
    completionMarkers: ["X"], errorPatterns: ["X"], excludePatterns: ["X"], excludeTitleKeywords: ["X"], escalationPressureLadder: ["X"], frustrationTriggers: ["X"],
  })
  const merged = result as unknown as Record<string, unknown>
  for (const keyName of STRING_LIST_KEYS) {
    assert.deepEqual(merged[keyName], ["X"], `${keyName} must keep its usable entries`)
  }
  assert.deepEqual(messages, [], "a legal list must not be reported")
})

test("mergeConfig ignores a markerRegex with nested quantifiers and reports it once", () => {
  const unsafeSources = ["(a+)+", "(a*)*", "(a+)*", "(a*)+"]
  for (const unsafeSource of unsafeSources) {
    const { result, messages } = mergeWithDiagnostics({ markerRegex: unsafeSource }, { ...DEFAULT_CONFIG, markerRegex: "BASE" })
    assert.equal(result.markerRegex, "BASE", `${unsafeSource} must be ignored`)
    assert.equal(messages.length, 1, `${unsafeSource} must produce exactly one console.error`)
    assert.ok(messages[0].includes("markerRegex"), "the report must name the markerRegex key")
  }
})

test("mergeConfig ignores a markerRegex that is not a valid regular expression", () => {
  const { result, messages } = mergeWithDiagnostics({ markerRegex: "[" }, { ...DEFAULT_CONFIG, markerRegex: "BASE" })
  assert.equal(result.markerRegex, "BASE")
  assert.equal(messages.length, 1)
  assert.ok(messages[0].includes("markerRegex"))
})

test("mergeConfig ignores a markerRegex longer than the accepted source limit", () => {
  const { result, messages } = mergeWithDiagnostics({ markerRegex: "a".repeat(1025) }, { ...DEFAULT_CONFIG, markerRegex: "BASE" })
  assert.equal(result.markerRegex, "BASE")
  assert.equal(messages.length, 1)
  assert.ok(messages[0].includes("markerRegex"))
})

test("mergeConfig keeps a valid markerRegex unchanged and reports nothing", () => {
  const { result, messages } = mergeWithDiagnostics({ markerRegex: "DONE" })
  assert.equal(result.markerRegex, "DONE")
  assert.deepEqual(messages, [])
})

test("mergeConfig clamps negative delays to zero", () => {
  const { result, messages } = mergeWithDiagnostics({ idleDelayMs: -1, minIntervalMs: -1, userGraceMs: -1 })
  assert.equal(result.idleDelayMs, 0)
  assert.equal(result.minIntervalMs, 0)
  assert.equal(result.userGraceMs, 0)
  assert.equal(messages.length, 3, "every rewritten key must produce exactly one diagnostic")
  for (const keyName of ["idleDelayMs", "minIntervalMs", "userGraceMs"]) {
    const message = messages.find((entry) => entry.includes(`"${keyName}"`))
    assert.ok(message, `the diagnostic must name ${keyName}`)
    assert.ok(message.includes("-1"), "the diagnostic must include the original value")
    assert.ok(message.includes("using 0"), "the diagnostic must include the effective value")
  }
})

test("mergeConfig keeps an explicit zero delay meaningful", () => {
  const { result, messages } = mergeWithDiagnostics({ userGraceMs: 0, intervalMs: 0 })
  assert.equal(result.userGraceMs, 0, "0 ms of user grace must stay 0")
  assert.equal(result.intervalMs, 0, "0 ms of periodic check must stay 0 (disabled)")
  assert.deepEqual(messages, [], "a documented zero is not a rewrite and must not be reported")
})

test("mergeConfig rejects an invalid clock window and reports the key and the bad value", () => {
  const invalidTimes = ["25:00", "08:99", "8:3", "24:00", "12:60", "abc"]
  for (const invalidTime of invalidTimes) {
    const { result, messages } = mergeWithDiagnostics({ startTime: invalidTime })
    assert.equal(result.startTime, "", `${invalidTime} must fall back to an empty window`)
    assert.equal(messages.length, 1, `${invalidTime} must produce exactly one console.error`)
    assert.ok(messages[0].includes("startTime"), "the report must name the startTime key")
    assert.ok(messages[0].includes(invalidTime), "the report must include the rejected value")
  }
})

test("mergeConfig keeps a valid clock window unchanged", () => {
  for (const validTime of ["8:30", "08:30", "23:59", "00:00"]) {
    const { result, messages } = mergeWithDiagnostics({ startTime: validTime })
    assert.equal(result.startTime, validTime)
    assert.deepEqual(messages, [])
  }
})

test("mergeConfig accepts an empty clock window without reporting anything", () => {
  const { result, messages } = mergeWithDiagnostics({ startTime: "" })
  assert.equal(result.startTime, "")
  assert.deepEqual(messages, [])
})

test("mergeConfig clamps a timer delay above the maximum timer range", () => {
  const maximumTimerDelay = 2_147_483_647
  for (const keyName of ["intervalMs", "idleDelayMs", "minIntervalMs"] as const) {
    const { result, messages } = mergeWithDiagnostics({ [keyName]: 3_000_000_000 })
    assert.equal(result[keyName], maximumTimerDelay)
    assert.equal(messages.length, 1)
    assert.ok(messages[0].includes(keyName), "the report must name the clamped key")
    assert.ok(messages[0].includes("3000000000"), "the report must include the original value")
    assert.ok(messages[0].includes(String(maximumTimerDelay)), "the report must include the effective ceiling")
  }
})

test("mergeConfig keeps the one second floor for a positive periodic interval", () => {
  const { result, messages } = mergeWithDiagnostics({ intervalMs: 500 })
  assert.equal(result.intervalMs, 1_000)
  assert.equal(messages.length, 1, "a floored value is a rewrite and must be reported exactly once")
  assert.ok(messages[0].includes("intervalMs"), "the report must name the clamped key")
  assert.ok(messages[0].includes("500"), "the report must include the original value")
  assert.ok(messages[0].includes("1000"), "the report must include the effective floor")
})

test("mergeConfig reports a negative periodic interval that is clamped to zero", () => {
  const { result, messages } = mergeWithDiagnostics({ intervalMs: -1 })
  assert.equal(result.intervalMs, 0)
  assert.equal(messages.length, 1, "every rewritten key must produce exactly one diagnostic")
  assert.ok(messages[0].includes("intervalMs"), "the report must name the clamped key")
  assert.ok(messages[0].includes("-1"), "the report must include the original value")
  assert.ok(messages[0].includes("using 0"), "the report must include the effective value")
})

test("mergeConfig reports a negative watch budget and a negative self-echo window", () => {
  const { result, messages } = mergeWithDiagnostics({ watchTimeoutMs: -1, selfEchoWindowMs: -2 })
  assert.equal(result.watchTimeoutMs, 0)
  assert.equal(result.selfEchoWindowMs, 0)
  assert.equal(messages.length, 2, "every rewritten key must produce exactly one diagnostic")
  for (const keyName of ["watchTimeoutMs", "selfEchoWindowMs"]) {
    const message = messages.find((entry) => entry.includes(`"${keyName}"`))
    assert.ok(message, `the diagnostic must name ${keyName}`)
    assert.ok(message.includes("using 0"), "the diagnostic must include the effective value")
  }
})

test("mergeConfig reports a negative injection cap that falls back to the base value", () => {
  const { result, messages } = mergeWithDiagnostics({ maxConsecutive: -3 }, { ...DEFAULT_CONFIG, maxConsecutive: 7 })
  assert.equal(result.maxConsecutive, 7)
  assert.equal(messages.length, 1, "every rewritten key must produce exactly one diagnostic")
  assert.ok(messages[0].includes("maxConsecutive"), "the report must name the clamped key")
  assert.ok(messages[0].includes("-3"), "the report must include the original value")
  assert.ok(messages[0].includes("using 7"), "the report must include the effective value")
})

test("mergeConfig reports a negative injection cap that falls back to the shipped default", () => {
  const { result, messages } = mergeWithDiagnostics({ maxConsecutive: -1 })
  assert.equal(result.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)
  assert.equal(messages.length, 1, "every rewritten key must produce exactly one diagnostic")
  assert.ok(messages[0].includes("maxConsecutive"), "the report must name the clamped key")
  assert.ok(messages[0].includes("-1"), "the report must include the original value")
  assert.ok(messages[0].includes(`using ${DEFAULT_CONFIG.maxConsecutive}`), "the report must include the effective value")
})

test("mergeConfig reports the verification bounds that it rewrites", () => {
  const lowerBounds = mergeWithDiagnostics({ verifyTimeoutMs: 10, verifyMaxIterations: -3 })
  assert.equal(lowerBounds.result.verifyTimeoutMs, 1_000)
  assert.equal(lowerBounds.result.verifyMaxIterations, 0)
  assert.equal(lowerBounds.messages.length, 2, "every rewritten key must produce exactly one diagnostic")
  assert.ok(lowerBounds.messages.some((message) => message.includes("verifyTimeoutMs") && message.includes("using 1000")), "the report must name the timeout key and its effective floor")
  assert.ok(lowerBounds.messages.some((message) => message.includes("verifyMaxIterations") && message.includes("using 0")), "the report must name the iteration key and its effective value")

  const upperBounds = mergeWithDiagnostics({ verifyTimeoutMs: 9_999_999, verifyMaxIterations: 99_999 })
  assert.equal(upperBounds.result.verifyTimeoutMs, 3_600_000)
  assert.equal(upperBounds.result.verifyMaxIterations, 10_000)
  assert.equal(upperBounds.messages.length, 2, "every rewritten key must produce exactly one diagnostic")
  assert.ok(upperBounds.messages.some((message) => message.includes("verifyTimeoutMs") && message.includes("using 3600000")), "the report must name the timeout key and its effective ceiling")
  assert.ok(upperBounds.messages.some((message) => message.includes("verifyMaxIterations") && message.includes("using 10000")), "the report must name the iteration key and its effective ceiling")
})

test("mergeConfig reports nothing for the legal lower boundary values", () => {
  const { result, messages } = mergeWithDiagnostics({
    idleDelayMs: 0, minIntervalMs: 0, maxConsecutive: 0, watchTimeoutMs: 0, userGraceMs: 0, intervalMs: 0, selfEchoWindowMs: 0,
    verifyTimeoutMs: 1_000, verifyMaxIterations: 0,
  })
  assert.equal(result.intervalMs, 0)
  assert.equal(result.userGraceMs, 0)
  assert.equal(result.verifyTimeoutMs, 1_000)
  assert.deepEqual(messages, [], "legal boundary values must not be reported")

  const oneSecondInterval = mergeWithDiagnostics({ intervalMs: 1_000 })
  assert.equal(oneSecondInterval.result.intervalMs, 1_000)
  assert.deepEqual(oneSecondInterval.messages, [], "the interval floor itself must not be reported")
})

test("mergeConfig reports nothing for the legal upper boundary values", () => {
  const maximumTimerDelay = 2_147_483_647
  const { result, messages } = mergeWithDiagnostics({
    idleDelayMs: maximumTimerDelay, minIntervalMs: maximumTimerDelay, intervalMs: maximumTimerDelay, verifyTimeoutMs: 3_600_000,
    verifyMaxIterations: 10_000,
  })
  assert.equal(result.idleDelayMs, maximumTimerDelay)
  assert.equal(result.minIntervalMs, maximumTimerDelay)
  assert.equal(result.intervalMs, maximumTimerDelay)
  assert.equal(result.verifyTimeoutMs, 3_600_000)
  assert.equal(result.verifyMaxIterations, 10_000)
  assert.deepEqual(messages, [], "legal boundary values must not be reported")
})

// --- the completion matcher filters blank markers on its own ---

test("buildCompletionMatcher returns null when every completion marker is blank", () => {
  // The config is built directly so the matcher's own blank filter is tested,
  // not the filter of the merge layer.
  const matcher = buildCompletionMatcher({ ...DEFAULT_CONFIG, completionMarkers: [""] })
  assert.equal(matcher, null)
})

test("buildCompletionMatcher ignores blank markers when building the regex", () => {
  const matcher = buildCompletionMatcher({ ...DEFAULT_CONFIG, completionMarkers: ["", "X"] })
  assert.ok(matcher, "a non-blank marker must still produce a matcher")
  assert.ok(matcher.test("X"))
  assert.equal(matcher.test(""), false, "a blank marker must not match every text")
})
