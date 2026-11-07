// Safety tests for config parsing + merging (F4 non-finite numbers, F5 string-aware trailing commas).
// Run: node --experimental-strip-types --test test/config-safety.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseJsonc, DEFAULT_CONFIG, mergeConfig } from "../src/config.ts"

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
