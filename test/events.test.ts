// Coverage for src/events.ts: the error normalization (errorToMatchString),
// the retry decision (isRetryableError) and the title exclusion check
// (titleExcluded).
//
// These are the match strings the server-side retry hook and the TUI message
// event path both rely on, so a divergence between the two paths would make
// the same failure match one route and miss the other.
//
// Run: node --experimental-strip-types --test test/events.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { errorToMatchString, isRetryableError, titleExcluded } from "../src/events.ts"

test("errorToMatchString formats a named error with its message", () => {
  const matchString = errorToMatchString({ name: "AI_Error", message: "bad_response_status_code 502" })
  assert.equal(matchString, "AI_Error: bad_response_status_code 502")
})

test("errorToMatchString prefers the nested data message over the top-level message", () => {
  const matchString = errorToMatchString({ name: "AI_Error", data: { message: "ContextOverflow" } })
  assert.equal(matchString, "AI_Error: ContextOverflow")
})

test("errorToMatchString returns a plain string error unchanged", () => {
  assert.equal(errorToMatchString("plain string"), "plain string")
})

test("errorToMatchString appends the status when the error carries one", () => {
  assert.equal(errorToMatchString({ name: "AI_Error", status: 502 }), "AI_Error: (status: 502)")
  assert.equal(
    errorToMatchString({ name: "AI_Error", message: "bad", status: 500 }),
    "AI_Error: bad (status: 500)",
  )
})

test("errorToMatchString falls back to the error type when the name is missing", () => {
  const matchString = errorToMatchString({
    type: "ai_error",
    message: "bad_response_status_code",
    status: 502,
  })
  assert.ok(matchString.includes("ai_error"), "the fallback type must appear in the match string")
  assert.ok(matchString.includes("bad_response_status_code"), "the message must appear in the match string")
  assert.ok(matchString.includes("(status: 502)"), "the status must appear in the match string")
})

test("errorToMatchString and the hand-built type/message string agree for the same error", () => {
  // The retry hook path labels a failure with `type`, the message event path
  // with `name`. Both must end up with the SAME match string, otherwise one
  // path matches a configured pattern and the other does not.
  const error = { type: "ai_error", message: "boom" }
  const fromEvents = errorToMatchString(error)
  const handBuilt = `${error.type}: ${error.message}`
  assert.equal(fromEvents.toLowerCase(), handBuilt.toLowerCase())
})

test("isRetryableError matches a configured error pattern", () => {
  const error = { name: "AI_Error", message: "boom" }
  assert.equal(isRetryableError(error, ["boom"], []), true)
})

test("isRetryableError refuses an error that matches an exclude pattern", () => {
  const error = { name: "AI_Error", message: "boom" }
  assert.equal(isRetryableError(error, [], ["boom"]), false)
})

test("isRetryableError ignores a blank error pattern instead of matching everything", () => {
  assert.equal(isRetryableError({ message: "anything" }, [""], []), false)
})

test("isRetryableError ignores a blank exclude pattern instead of blocking everything", () => {
  assert.equal(isRetryableError({ message: "anything" }, ["anything"], [""]), true)
})

test("titleExcluded skips a blank keyword instead of excluding every session", () => {
  assert.equal(titleExcluded("任意标题", [""]), false)
})

test("titleExcluded matches a configured title keyword", () => {
  assert.equal(titleExcluded("测试会话", ["测试"]), true)
})

test("titleExcluded returns false for a missing title", () => {
  assert.equal(titleExcluded(undefined, ["测试"]), false)
})

test("titleExcluded returns false when no keyword is configured", () => {
  assert.equal(titleExcluded("x", []), false)
})
