// Coverage for the JSONC parser of src/config.ts: comment and trailing-comma
// removal, the UTF-8 BOM prefix, the single-quote normalization and the
// escape semantics of both string flavors.
//
// The escape rules decide whether a config file a user actually wrote is
// usable: a single-quoted string is LITERAL (a Windows path keeps every
// backslash), while a double-quoted string follows strict JSON (a real
// newline stays a newline, an invalid escape still throws).
//
// Run: node --experimental-strip-types --test test/config-parse.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseJsonc } from "../src/config.ts"

/** The code points that must never show up in a preserved Windows path: tab,
 *  line feed, form feed and carriage return would all be the trace of a JSON
 *  escape that leaked into the value. */
const CONTROL_CHARACTER_CODE_POINTS = [9, 10, 12, 13]

/** The code points of every character of `value`. */
function codePoints(value: string): number[] {
  return [...value].map((character) => character.codePointAt(0) ?? 0)
}

/** The control characters that survived inside `value` (an empty list = none). */
function controlCharacters(value: string): number[] {
  return codePoints(value).filter((codePoint) => CONTROL_CHARACTER_CODE_POINTS.includes(codePoint))
}

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

// --- single-quoted strings are normalized to double-quoted ones ---

test("parseJsonc still normalizes single-quoted strings", () => {
  const parsed = parseJsonc("{ 'a': 'b' }") as { a: string }
  assert.equal(parsed.a, "b")
})

test("parseJsonc parses a single-quoted Windows path", () => {
  const parsed = parseJsonc("{ 'p': 'C:\\path' }") as { p: string }
  assert.equal(parsed.p, "C:\\path")
})

test("parseJsonc parses a multi-segment single-quoted Windows path", () => {
  const parsed = parseJsonc("{ 'p': 'C:\\Users\\Documents\\2024\\ok' }") as { p: string }
  assert.equal(parsed.p, "C:\\Users\\Documents\\2024\\ok")
})

test("parseJsonc keeps a realistic single-quoted Windows path intact", () => {
  // The path segments start with "n", "f" and "t" — all of them legal JSON
  // escape letters. A single-quoted string is literal, so none of them may
  // turn into a control character.
  const parsed = parseJsonc("{ 'p': 'C:\\Users\\name\\file.txt' }") as { p: string }
  assert.equal(parsed.p, "C:\\Users\\name\\file.txt")
  assert.deepEqual(controlCharacters(parsed.p), [], "the path must not contain control characters")
})

test("parseJsonc keeps a single-quoted path whose segment starts with t intact", () => {
  const parsed = parseJsonc("{ 'p': 'C:\\temp' }") as { p: string }
  assert.equal(parsed.p, "C:\\temp")
  assert.deepEqual(controlCharacters(parsed.p), [], "the path must not contain control characters")
})

test("parseJsonc keeps a newline escape literal inside a single-quoted string", () => {
  const parsed = parseJsonc("{ 'a': 'a\\nb' }") as { a: string }
  assert.equal(parsed.a, "a\\nb")
  assert.equal(parsed.a.length, 4, "the value must keep the backslash and the letter")
  assert.deepEqual(codePoints(parsed.a), [97, 92, 110, 98])
})

test("parseJsonc keeps a tab escape literal inside a single-quoted string", () => {
  const parsed = parseJsonc("{ 'a': 'a\\tb' }") as { a: string }
  assert.equal(parsed.a, "a\\tb")
  assert.equal(parsed.a.length, 4, "the value must keep the backslash and the letter")
  assert.deepEqual(codePoints(parsed.a), [97, 92, 116, 98])
})

test("parseJsonc keeps an escaped quote and an escaped backslash in a single-quoted string", () => {
  const quoteParsed = parseJsonc("{ 'a': 'a\\'b' }") as { a: string }
  assert.equal(quoteParsed.a, "a'b")
  const backslashParsed = parseJsonc("{ 'p': 'C:\\\\temp' }") as { p: string }
  assert.equal(backslashParsed.p, "C:\\temp")
})

test("parseJsonc keeps an unknown escape inside a single-quoted string literal", () => {
  const parsed = parseJsonc("{ 'a': '\\d' }") as { a: string }
  assert.equal(parsed.a, "\\d")
})

// --- a double-quoted string keeps strict JSON escape semantics ---

test("parseJsonc still interprets the JSON escapes inside a double-quoted string", () => {
  const parsed = parseJsonc('{ "a": "\\n", "b": "\\t", "c": "\\u0041" }') as {
    a: string
    b: string
    c: string
  }
  assert.equal(parsed.a, "\n")
  assert.equal(parsed.b, "\t")
  assert.equal(parsed.c, "A")
})

test("parseJsonc still rejects an invalid escape inside a double-quoted string", () => {
  assert.throws(() => parseJsonc('{ "a": "\\d" }'), SyntaxError)
})
