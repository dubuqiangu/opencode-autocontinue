// Safety tests for config parsing + merging (F4 non-finite numbers, F5 string-aware trailing commas).
// Run: node --experimental-strip-types --test --test-force-exit test/config-safety.test.ts

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
