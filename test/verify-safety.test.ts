// Safety tests for src/verify.ts: the live stream output cap (§7.1) and the
// real default-spawn integration path through runVerification.
// Run: node --experimental-strip-types --test test/verify-safety.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { appendBoundedCapped, runVerification } from "../src/verify.ts"

test("appendBoundedCapped returns identical string when under the byte limit", () => {
  const buffer = "hello "
  const chunk = "world"
  assert.equal(appendBoundedCapped(buffer, chunk, 1024), "hello world")
})

test("appendBoundedCapped keeps the first and last bytes when over the limit", () => {
  const headMarker = "HEAD-MARKER-"
  const tailMarker = "-TAIL-MARKER"
  const middle = "x".repeat(20_000)
  const capped = appendBoundedCapped("", headMarker + middle + tailMarker, 8 * 1024)
  assert.ok(Buffer.byteLength(capped, "utf8") <= 8 * 1024)
  assert.ok(capped.includes(headMarker))
  assert.ok(capped.includes(tailMarker))
})

test("appendBoundedCapped does not throw when a boundary splits a multi-byte char", () => {
  const multiByteText = "é".repeat(10_000) // 2 bytes each -> halves land mid-char
  const capped = appendBoundedCapped("", multiByteText, 8 * 1024)
  assert.ok(Buffer.byteLength(capped, "utf8") <= 8 * 1024)
})

test("runVerification caps live stdout from a real child process", async () => {
  const result = await runVerification({
    argv: [process.execPath, "-e", "process.stdout.write('A'.repeat(20000) + 'END')"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  })
  assert.equal(result.spawnUnavailable, false)
  assert.ok(result.stdout.length < 20_000)
  assert.ok(result.stdout.includes("END"))
})

// F12: a multibyte UTF-8 sequence split across two stdout data events must be
// reassembled, not decoded per-chunk into U+FFFD. The child emits the two bytes
// of "é" in separate writes (a 30ms gap guarantees two data events), then a
// large body so the 8KB live cap still applies.
test("runVerification decodes a split multibyte sequence without U+FFFD", async () => {
  const splitMultibyteScript = [
    "process.stdout.write(Buffer.from([0xc3]));",
    "setTimeout(() => {",
    "  process.stdout.write(Buffer.from([0xa9]));",
    '  process.stdout.write("\\u00e9".repeat(5000));',
    "}, 30);",
  ].join("\n")
  const result = await runVerification({
    argv: [process.execPath, "-e", splitMultibyteScript],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  })
  assert.equal(result.spawnUnavailable, false)
  assert.ok(!result.stdout.includes("\uFFFD"), "split multibyte char was replaced with U+FFFD")
  assert.ok(result.stdout.includes("\u00e9"), "reassembled é should survive the head")
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 8 * 1024)
})

// F9: the grace kill timer must be cleared on finish, so a resolved verification
// has no dangling timer. Aborting an already-aborted signal exercises the
// stopGracefully -> setTimeout(killTree, GRACE_MS) path; the call must resolve
// promptly (well under GRACE_MS + 500ms), not hang on the orphan timer.
test("runVerification resolves promptly after a grace kill", async () => {
  const abortController = new AbortController()
  abortController.abort()
  const startedAt = Date.now()
  await runVerification({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    signal: abortController.signal,
  })
  const elapsedMs = Date.now() - startedAt
  assert.ok(elapsedMs < 1_000 + 500, `resolved in ${elapsedMs}ms, expected well under GRACE_MS+500`)
})
