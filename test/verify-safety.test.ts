// Safety tests for src/verify.ts: the live stream output cap (§7.1) and the
// real default-spawn integration path through runVerification.
// Run: node --experimental-strip-types --test --test-force-exit test/verify-safety.test.ts

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
