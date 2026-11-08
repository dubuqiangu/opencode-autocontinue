// Safety tests for config parsing + merging (F4 non-finite numbers, F5 string-aware trailing commas).
// Run: node --experimental-strip-types --test test/config-safety.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseJsonc, DEFAULT_CONFIG, mergeConfig, buildCompletionMatcher } from "../src/config.ts"

// --- F5: trailing-comma removal must be string-aware ---

test("parseJsonc preserves a comma inside a double-quoted string", () => {
  const parsed = parseJsonc('{ "message": "step done,}", "x": 1 }')
  assert.equal(parsed.message, "step done,}")
  assert.equal(parsed.x, 1)
})

test("parseJsonc preserves a comma followed by a space and bracket inside a string", () => {
  const parsed = parseJsonc('{ "a": "keep, ] this" }')
  assert.equal(parsed.a, "keep, ] this")
})

test("parseJsonc still strips a real trailing comma in objects and arrays", () => {
  const objectParsed = parseJsonc('{ "a": 1, "b": 2, }')
  assert.equal(objectParsed.a, 1)
  assert.equal(objectParsed.b, 2)

  const arrayParsed = parseJsonc('{ "list": [1, 2, ], }')
  assert.deepEqual(arrayParsed.list, [1, 2])
})

test("parseJsonc keeps a ,} inside a single-quoted string with // and /* */ comments", () => {
  const raw = `{
    // a line comment
    'message': 'step done,}',
    /* a block comment */
    'x': 1,
  }`
  const parsed = parseJsonc(raw)
  assert.equal(parsed.message, "step done,}")
  assert.equal(parsed.x, 1)
})

// --- F4: non-finite numeric overrides fall back to the base value ---

test("mergeConfig falls back to defaults for non-finite numeric overrides", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    idleDelayMs: 1e400,
    minIntervalMs: -1e400,
    maxConsecutive: 1e400,
    userGraceMs: 1e400,
    intervalMs: 1e400,
    watchTimeoutMs: 1e400,
    selfEchoWindowMs: 1e400,
    verifyTimeoutMs: 1e400,
    verifyMaxIterations: 1e400,
  })
  assert.equal(merged.idleDelayMs, DEFAULT_CONFIG.idleDelayMs)
  assert.equal(merged.minIntervalMs, DEFAULT_CONFIG.minIntervalMs)
  assert.equal(merged.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)
  assert.equal(merged.userGraceMs, DEFAULT_CONFIG.userGraceMs)
  assert.equal(merged.intervalMs, DEFAULT_CONFIG.intervalMs)
  assert.equal(merged.watchTimeoutMs, DEFAULT_CONFIG.watchTimeoutMs)
  assert.equal(merged.selfEchoWindowMs, DEFAULT_CONFIG.selfEchoWindowMs)
  assert.equal(merged.verifyTimeoutMs, DEFAULT_CONFIG.verifyTimeoutMs)
  assert.equal(merged.verifyMaxIterations, DEFAULT_CONFIG.verifyMaxIterations)
})

test("mergeConfig falls back to defaults for NaN numeric overrides", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    idleDelayMs: Number.NaN,
    verifyTimeoutMs: Number.NaN,
    verifyMaxIterations: Number.NaN,
  })
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
  assert.equal(mergeConfig(DEFAULT_CONFIG, { verifyTimeoutMs: 10 }).verifyTimeoutMs, 1_000)
  assert.equal(mergeConfig(DEFAULT_CONFIG, { verifyTimeoutMs: 9_999_999 }).verifyTimeoutMs, 3_600_000)
  assert.equal(mergeConfig(DEFAULT_CONFIG, { verifyMaxIterations: -3 }).verifyMaxIterations, 0)
  assert.equal(mergeConfig(DEFAULT_CONFIG, { verifyMaxIterations: 99_999 }).verifyMaxIterations, 10_000)
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
  const merged = mergeConfig(DEFAULT_CONFIG, {
    watchTimeoutMs: Number.POSITIVE_INFINITY,
    verifyMaxIterations: Number.NaN,
  })
  assert.equal(merged.watchTimeoutMs, DEFAULT_CONFIG.watchTimeoutMs)
  assert.equal(merged.verifyMaxIterations, DEFAULT_CONFIG.verifyMaxIterations)
})

// --- P2: frustration trigger merging ---

test("the frustration trigger list is off by default and its message has the spec text", () => {
  assert.deepEqual(DEFAULT_CONFIG.frustrationTriggers, [])
  assert.equal(
    DEFAULT_CONFIG.frustrationMessage,
    "用户明确表达了对质量的不满：换本质不同的方法重新推进，并贴出可核对的验证证据（命令 + 输出），不要只改措辞。",
  )
})

test("mergeConfig replaces the frustration trigger list and drops blank entries", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    frustrationTriggers: ["不满意", "", "太差了", 42, null],
  })
  // The provided array REPLACES the default (never concatenated) and only
  // non-empty strings survive.
  assert.deepEqual(merged.frustrationTriggers, ["不满意", "太差了"])
})

test("mergeConfig honors an explicit empty frustration trigger list (feature off)", () => {
  const merged = mergeConfig({ ...DEFAULT_CONFIG, frustrationTriggers: ["不满意"] }, {
    frustrationTriggers: [],
  })
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

// --- A1: trailing-comma detection must look past comments (skipTrivia) ---

test("parseJsonc accepts a trailing comma followed by a line comment", () => {
  const parsed = parseJsonc('{"a": 1, // c\n}') as { a: number }
  assert.equal(parsed.a, 1)
})

test("parseJsonc accepts a trailing comma followed by a block comment", () => {
  const parsed = parseJsonc('{"a": 1, /* c */ }') as { a: number }
  assert.equal(parsed.a, 1)
})

test("parseJsonc accepts a trailing comma after a commented array element", () => {
  const parsed = parseJsonc('{"list": [1,2, // c\n], }') as { list: number[] }
  assert.deepEqual(parsed.list, [1, 2])
})

test("parseJsonc accepts a line comment after the last value without a trailing comma", () => {
  const parsed = parseJsonc('{"a": 1 // c\n}') as { a: number }
  assert.equal(parsed.a, 1)
})

test("parseJsonc accepts a commented trailing comma in a realistic config snippet", () => {
  const parsed = parseJsonc('{\n  "maxConsecutive": 5, // 每天最多 5 次\n}') as { maxConsecutive: number }
  assert.equal(parsed.maxConsecutive, 5)
})

test("parseJsonc keeps commas, brackets and URL slashes that live inside a string", () => {
  const parsed = parseJsonc('{ "a": "x,}y", "b": "z,]w", "url": "http://example.com/p" }') as {
    a: string
    b: string
    url: string
  }
  assert.equal(parsed.a, "x,}y")
  assert.equal(parsed.b, "z,]w")
  assert.equal(parsed.url, "http://example.com/p")
})

test("parseJsonc still tolerates a UTF-8 BOM prefix", () => {
  const parsed = parseJsonc('\uFEFF{"a": 1}') as { a: number }
  assert.equal(parsed.a, 1)
})

test("parseJsonc still normalizes single-quoted strings", () => {
  const parsed = parseJsonc("{ 'a': 'b' }") as { a: string }
  assert.equal(parsed.a, "b")
})

test("parseJsonc currently rejects a single-quoted Windows path (KNOWN DEFECT, not the expected behavior)", () => {
  // KNOWN DEFECT — this test only RECORDS the current behavior, it is NOT the
  // expected behavior: the single-quote normalizer keeps the raw backslash, so
  // "C:\path" becomes the JSON string "C:\path" whose "\p" escape is invalid
  // and makes JSON.parse throw. When the defect is fixed this test must be
  // replaced by an assertion that the value parses back to "C:\path".
  assert.throws(() => parseJsonc("{ 'p': 'C:\\path' }"), SyntaxError)
})

// --- A2: mergeConfig validation layer ---

/** Run `action` with console.error captured; returns the result and the
 *  collected error messages (console.error is always restored). */
function withCapturedConsoleErrors<Result>(action: () => Result): { result: Result; messages: string[] } {
  const messages: string[] = []
  const originalError = console.error
  console.error = (...errorArguments: unknown[]) => {
    messages.push(errorArguments.map((argument) => String(argument)).join(" "))
  }
  try {
    return { result: action(), messages }
  } finally {
    console.error = originalError
  }
}

test("mergeConfig drops blank entries from every string list override", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    completionMarkers: ["", "X"],
    errorPatterns: ["", "X"],
    excludePatterns: ["", "X"],
    excludeTitleKeywords: ["", "X"],
    escalationPressureLadder: ["", "X"],
    frustrationTriggers: ["", "X"],
  })
  assert.deepEqual(merged.completionMarkers, ["X"])
  assert.deepEqual(merged.errorPatterns, ["X"])
  assert.deepEqual(merged.excludePatterns, ["X"])
  assert.deepEqual(merged.excludeTitleKeywords, ["X"])
  assert.deepEqual(merged.escalationPressureLadder, ["X"])
  assert.deepEqual(merged.frustrationTriggers, ["X"])
})

test("mergeConfig honors an explicitly empty string list override", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    completionMarkers: [],
    errorPatterns: [],
    excludePatterns: [],
    excludeTitleKeywords: [],
    escalationPressureLadder: [],
    frustrationTriggers: [],
  })
  assert.deepEqual(merged.completionMarkers, [])
  assert.deepEqual(merged.errorPatterns, [])
  assert.deepEqual(merged.excludePatterns, [])
  assert.deepEqual(merged.excludeTitleKeywords, [])
  assert.deepEqual(merged.escalationPressureLadder, [])
  assert.deepEqual(merged.frustrationTriggers, [])
})

test("mergeConfig ignores a markerRegex with nested quantifiers and reports it once", () => {
  const unsafeSources = ["(a+)+", "(a*)*", "(a+)*", "(a*)+"]
  for (const unsafeSource of unsafeSources) {
    const { result, messages } = withCapturedConsoleErrors(() =>
      mergeConfig({ ...DEFAULT_CONFIG, markerRegex: "BASE" }, { markerRegex: unsafeSource }),
    )
    assert.equal(result.markerRegex, "BASE", `${unsafeSource} must be ignored`)
    assert.equal(messages.length, 1, `${unsafeSource} must produce exactly one console.error`)
    assert.ok(messages[0].includes("markerRegex"), "the report must name the markerRegex key")
  }
})

test("mergeConfig ignores a markerRegex that is not a valid regular expression", () => {
  const { result, messages } = withCapturedConsoleErrors(() =>
    mergeConfig({ ...DEFAULT_CONFIG, markerRegex: "BASE" }, { markerRegex: "[" }),
  )
  assert.equal(result.markerRegex, "BASE")
  assert.equal(messages.length, 1)
  assert.ok(messages[0].includes("markerRegex"))
})

test("mergeConfig ignores a markerRegex longer than the accepted source limit", () => {
  const { result, messages } = withCapturedConsoleErrors(() =>
    mergeConfig({ ...DEFAULT_CONFIG, markerRegex: "BASE" }, { markerRegex: "a".repeat(1025) }),
  )
  assert.equal(result.markerRegex, "BASE")
  assert.equal(messages.length, 1)
  assert.ok(messages[0].includes("markerRegex"))
})

test("mergeConfig keeps a valid markerRegex unchanged and reports nothing", () => {
  const { result, messages } = withCapturedConsoleErrors(() =>
    mergeConfig(DEFAULT_CONFIG, { markerRegex: "DONE" }),
  )
  assert.equal(result.markerRegex, "DONE")
  assert.deepEqual(messages, [])
})

test("mergeConfig clamps negative delays to zero", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { idleDelayMs: -1, minIntervalMs: -1, userGraceMs: -1 })
  assert.equal(merged.idleDelayMs, 0)
  assert.equal(merged.minIntervalMs, 0)
  assert.equal(merged.userGraceMs, 0)
})

test("mergeConfig keeps an explicit zero delay meaningful", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { userGraceMs: 0, intervalMs: 0 })
  assert.equal(merged.userGraceMs, 0, "0 ms of user grace must stay 0")
  assert.equal(merged.intervalMs, 0, "0 ms of periodic check must stay 0 (disabled)")
})

test("mergeConfig rejects an invalid clock window and reports the key and the bad value", () => {
  const invalidTimes = ["25:00", "08:99", "8:3", "24:00", "12:60", "abc"]
  for (const invalidTime of invalidTimes) {
    const { result, messages } = withCapturedConsoleErrors(() =>
      mergeConfig(DEFAULT_CONFIG, { startTime: invalidTime }),
    )
    assert.equal(result.startTime, "", `${invalidTime} must fall back to an empty window`)
    assert.equal(messages.length, 1, `${invalidTime} must produce exactly one console.error`)
    assert.ok(messages[0].includes("startTime"), "the report must name the startTime key")
    assert.ok(messages[0].includes(invalidTime), "the report must include the rejected value")
  }
})

test("mergeConfig keeps a valid clock window unchanged", () => {
  for (const validTime of ["8:30", "08:30", "23:59", "00:00"]) {
    const { result, messages } = withCapturedConsoleErrors(() =>
      mergeConfig(DEFAULT_CONFIG, { startTime: validTime }),
    )
    assert.equal(result.startTime, validTime)
    assert.deepEqual(messages, [])
  }
})

test("mergeConfig accepts an empty clock window without reporting anything", () => {
  const { result, messages } = withCapturedConsoleErrors(() => mergeConfig(DEFAULT_CONFIG, { startTime: "" }))
  assert.equal(result.startTime, "")
  assert.deepEqual(messages, [])
})

test("mergeConfig clamps a timer delay above the maximum timer range", () => {
  const maximumTimerDelay = 2_147_483_647
  for (const keyName of ["intervalMs", "idleDelayMs", "minIntervalMs"] as const) {
    const { result, messages } = withCapturedConsoleErrors(() =>
      mergeConfig(DEFAULT_CONFIG, { [keyName]: 3_000_000_000 }),
    )
    assert.equal(result[keyName], maximumTimerDelay)
    assert.equal(messages.length, 1)
    assert.ok(messages[0].includes(keyName), "the report must name the clamped key")
  }
})

test("mergeConfig keeps the one second floor for a positive periodic interval", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { intervalMs: 500 })
  assert.equal(merged.intervalMs, 1_000)
})

test("buildCompletionMatcher returns null when every completion marker is blank", () => {
  const config = mergeConfig(DEFAULT_CONFIG, { completionMarkers: [""] })
  assert.equal(buildCompletionMatcher(config), null)
})

test("buildCompletionMatcher ignores blank markers when building the regex", () => {
  const config = mergeConfig(DEFAULT_CONFIG, { completionMarkers: ["", "X"] })
  const matcher = buildCompletionMatcher(config)
  assert.ok(matcher, "a non-blank marker must still produce a matcher")
  assert.ok(matcher.test("X"))
  assert.equal(matcher.test(""), false, "a blank marker must not match every text")
})
