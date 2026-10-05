// Unit tests for opencode-autocontinue server logic.
// Run: node --test test/*.test.mjs

import { test } from "node:test"
import assert from "node:assert/strict"

// --- config ---
import { parseJsonc, DEFAULT_CONFIG, mergeConfig, buildCompletionMatcher } from "../src/config.ts"

test("parseJsonc strips comments and trailing commas", () => {
  const raw = `{
    // line comment
    "enabled": true,
    "message": "继续 {time}",
    /* block
       comment */
    "maxConsecutive": 5,
  }`
  const parsed = parseJsonc(raw)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.message, "继续 {time}")
  assert.equal(parsed.maxConsecutive, 5)
})

test("parseJsonc throws on invalid jsonc", () => {
  assert.throws(() => parseJsonc("{ not json !!! }"))
})

test("buildCompletionMatcher escapes markers and matches case-insensitively", () => {
  const matcher = buildCompletionMatcher(DEFAULT_CONFIG)
  assert.ok(matcher.test("[任务完成] 一切就绪"))
  assert.ok(matcher.test("a <promise>DONE</promise> b"))
  assert.ok(!matcher.test("ordinary summary without markers"))
})

test("mergeConfig merges only known keys with correct types", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    enabled: false,
    message: "custom",
    maxConsecutive: 3,
    bogusKey: "ignored",
    excludeTitleKeywords: ["demo", "测试"],
  })
  assert.equal(merged.enabled, false)
  assert.equal(merged.message, "custom")
  assert.equal(merged.maxConsecutive, 3)
  assert.deepEqual(merged.excludeTitleKeywords, ["demo", "测试"])
  assert.equal(merged.idleDelayMs, DEFAULT_CONFIG.idleDelayMs)
})

// --- events ---
import {
  sessionIDFromEvent,
  isRetryableError,
  errorToMatchString,
  messageText,
  hasCompletionMarker,
  titleExcluded,
} from "../src/events.ts"

test("sessionIDFromEvent handles flat and nested shapes", () => {
  assert.equal(sessionIDFromEvent({ type: "x", sessionID: "ses_flat" }), "ses_flat")
  assert.equal(sessionIDFromEvent({ type: "x", properties: { sessionID: "ses_nested" } }), "ses_nested")
  assert.equal(sessionIDFromEvent({ type: "x", data: { sessionID: "ses_data" } }), "ses_data")
  assert.equal(sessionIDFromEvent({ type: "x" }), undefined)
})

test("errorToMatchString includes name and message", () => {
  assert.equal(errorToMatchString({ name: "AI_Error", message: "bad_response_status_code 502" }), "AI_Error: bad_response_status_code 502")
  assert.equal(errorToMatchString({ name: "AI_Error", data: { message: "ContextOverflow" } }), "AI_Error: ContextOverflow")
  assert.equal(errorToMatchString("plain string"), "plain string")
})

test("isRetryableError matches retryable patterns and honors excludes", () => {
  const patterns = ["bad_response_status_code", "ECONNRESET", "timeout"]
  assert.ok(isRetryableError({ message: "bad_response_status_code" }, patterns, []))
  assert.ok(isRetryableError({ message: "ECONNRESET" }, patterns, []))
  assert.ok(!isRetryableError({ message: "user said stop" }, patterns, []))
  assert.ok(!isRetryableError({ message: "operation was aborted" }, patterns, ["operation was aborted"]))
})

test("messageText joins text parts only", () => {
  const parts = [
    { type: "text", text: "hello " },
    { type: "tool", name: "x" },
    { type: "text", text: "world" },
  ]
  assert.equal(messageText(parts), "hello \nworld")
})

test("hasCompletionMarker and titleExcluded", () => {
  const matcher = /\[任务完成\]/i
  assert.ok(hasCompletionMarker("done: [任务完成]", matcher))
  assert.ok(!hasCompletionMarker("still working", matcher))
  assert.ok(titleExcluded("临时测试会话", ["测试"]))
  assert.ok(!titleExcluded("生产会话", ["测试"]))
})

// --- prompt ---
import { renderMessage, injectContinuation } from "../src/prompt.ts"

test("renderMessage replaces {time} and {remaining}", () => {
  const out = renderMessage("now={time}, left={remaining}", Date.now() + 2 * 3_600_000)
  assert.match(out, /^now=.*, left=2\.0 小时$/)
  const outMinutes = renderMessage("left={remaining}", Date.now() + 30 * 60_000)
  assert.match(outMinutes, /^left=30 分钟$/)
})

test("injectContinuation calls session.prompt with rendered text", async () => {
  let called: { sessionID: string; text: string } | undefined
  const session = {
    async prompt(input: { sessionID: string; text: string }) {
      called = input
    },
  }
  await injectContinuation(session, "ses_1", "继续 {time}", Date.now() + 60_000)
  assert.equal(called?.sessionID, "ses_1")
  assert.match(called?.text ?? "", /^继续 /)
})

// --- engine decision matrix ---
import { AutocontinueEngine, computeEndAt, startTimeNotReached, retryHookHandler } from "../src/engine.ts"
import { WatchStore } from "../src/state.ts"

class FakeStorage {
  private data = new Map<string, unknown>()
  async get(key: string) { return this.data.get(key) }
  async set(key: string, value: unknown) { this.data.set(key, value) }
}

function makeFakeSession() {
  return {
    prompts: [] as string[],
    hooks: [] as Array<{ name: string; fn: (e: any) => void | Promise<void> }>,
    async prompt(input: { sessionID: string; text: string }) {
      this.prompts.push(input.text)
    },
    async hook(name: string, fn: (e: any) => void | Promise<void>) {
      this.hooks.push({ name, fn })
    },
    async context() {
      return [] // no messages
    },
  }
}

async function makeEngine(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: Array<{ sessionID: string; state: string; consecutive: number }> = []
  const config = () => ({ ...DEFAULT_CONFIG, ...overrides })
  const engine = new AutocontinueEngine(session as any, config, store, (sid, state, consecutive) => {
    events.push({ sessionID: sid, state, consecutive })
  })
  return { session, store, engine, events }
}

test("computeEndAt returns today's timestamp and 0 for empty", () => {
  assert.equal(computeEndAt("", ""), 0)
  const today = computeEndAt("23:59", "")
  const expected = new Date()
  expected.setHours(23, 59, 0, 0)
  assert.equal(today, expected.getTime())
  // A passed time still returns today's timestamp (daily cutoff semantics).
  const past = new Date(Date.now() - 60_000)
  const pastTime = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`
  const pastExpected = new Date()
  pastExpected.setHours(past.getHours(), past.getMinutes(), 0, 0)
  assert.equal(computeEndAt(pastTime, ""), pastExpected.getTime())
})

test("startTimeNotReached", () => {
  // Empty = always open
  assert.equal(startTimeNotReached(""), false)
  // A time one minute in the future is not reached yet
  const future = new Date(Date.now() + 60_000)
  const futureTime = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`
  assert.equal(startTimeNotReached(futureTime), true)
  // A time one minute in the past is reached
  const past = new Date(Date.now() - 60_000)
  const pastTime = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`
  assert.equal(startTimeNotReached(pastTime), false)
})

test("retryHookHandler rewrites retryable errors with exponential backoff", () => {
  const event = {
    error: { type: "AI_Error", message: "bad_response_status_code", status: 502 },
    attempt: 3,
    decision: { retry: false },
  }
  retryHookHandler(() => DEFAULT_CONFIG, event as any)
  assert.equal(event.decision.retry, true)
  assert.equal(event.decision.delay, 2_000 * 2 ** 2) // 8s
})

test("retryHookHandler ignores excluded errors", () => {
  const event = {
    error: { type: "MessageAbortedError", message: "operation was aborted" },
    attempt: 1,
    decision: { retry: false },
  }
  retryHookHandler(() => DEFAULT_CONFIG, event as any)
  assert.equal(event.decision.retry, false)
})

test("installRetryHook registers hook", async () => {
  const { session, engine } = await makeEngine()
  await engine.installRetryHook()
  assert.equal(session.hooks.length, 1)
  assert.equal(session.hooks[0].name, "retry")
})

test("idle with pending error schedules injection after idleDelayMs", async () => {
  const { session, store, engine, events } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_1")
  await engine.handleEvent({ type: "session.error", sessionID: "ses_1", error: { message: "bad_response_status_code" } })
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_1" })
  // Error path enforces a 1s minimum delay.
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0], /^继续执行/)
  assert.equal(events.length, 1)
  assert.equal(events[0].state, "watching")
})

test("idle without error also resumes (stage-complete)", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_2")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_2" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 1)
})

test("maxConsecutive cap stops watching", async () => {
  const { session, store, engine, events } = await makeEngine({ idleDelayMs: 5, maxConsecutive: 2, minIntervalMs: 0 })
  await store.watch("ses_3")
  // Two successful injections
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_3" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_3" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 2)
  // Third idle hits cap -> stopped, no injection
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_3" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 2)
  const status = store.status("ses_3")
  assert.equal(status.state?.state, "stopped")
  assert.ok(events.some((event) => event.state === "stopped"))
})

test("completion marker in last assistant text marks done", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, (_, state) => {
    events.push(state)
  })
  await store.watch("ses_4")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_4" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_4").state?.state, "done")
  assert.ok(events.includes("done"))
})

test("title exclusion stops watching", async () => {
  const session = makeFakeSession()
  session.context = async () => [{ info: { role: "user", title: "临时测试会话" } }]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_5")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_5" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_5").state?.state, "stopped")
})

test("user message within grace window delays injection", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5, userGraceMs: 60_000 })
  await store.watch("ses_6")
  await engine.handleEvent({
    type: "message.updated",
    sessionID: "ses_6",
    properties: { info: { role: "user" } },
  })
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_6" })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(session.prompts.length, 0) // inside grace -> rescheduled, not injected
})

test("off via rpc unwatch stops injections", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_7")
  await store.unwatch("ses_7")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_7" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
})

test("endTime reached marks stopped", async () => {
  const past = new Date(Date.now() - 60_000)
  const endTime = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`
  const { session, store, engine } = await makeEngine({ endTime, idleDelayMs: 5 })
  await store.watch("ses_8", computeEndAt(endTime, ""))
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_8" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_8").state?.state, "stopped")
})

test("retry hook rewrite uses retryHookHandler via engine", async () => {
  const { session, engine } = await makeEngine()
  await engine.installRetryHook()
  const event = {
    error: { type: "AI_Error", message: "ECONNRESET" },
    attempt: 1,
    decision: { retry: false },
  }
  await session.hooks?.[0]?.fn?.(event)
  assert.equal(event.decision.retry, true)
})
// --- regression tests for server fixes ---

test("buildCompletionMatcher returns null when no completion markers configured", () => {
  const matcher = buildCompletionMatcher({ ...DEFAULT_CONFIG, completionMarkers: [], markerRegex: "" })
  assert.equal(matcher, null)
  // null matcher 不会匹配任何完成标记。
  assert.equal(hasCompletionMarker("任意文本 [任务完成]", null), false)
})

test("buildCompletionMatcher falls back to markers on invalid markerRegex", () => {
  const matcher = buildCompletionMatcher({ ...DEFAULT_CONFIG, markerRegex: "(unclosed" })
  assert.ok(matcher instanceof RegExp)
  assert.ok(matcher.test("[任务完成] 完成"))
})

test("parseJsonc accepts single-quoted strings", () => {
  const parsed = parseJsonc(`{ 'enabled': true, 'message': "it's fine" }`)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.message, "it's fine")
})

test("parseJsonc converts single-quoted strings with embedded double quotes", () => {
  const parsed = parseJsonc(`{ 'message': '他说 "你好"' }`)
  assert.equal(parsed.message, '他说 "你好"')
})

test("parseJsonc unescapes escaped single quotes inside single-quoted strings", () => {
  const parsed = parseJsonc(`{ 'message': 'it\\'s ok' }`)
  assert.equal(parsed.message, "it's ok")
})

test("computeEndAt rolls past endTime to tomorrow for cross-midnight windows", () => {
  const now = new Date()
  const today830 = new Date(now)
  today830.setHours(8, 30, 0, 0)
  const result = computeEndAt("08:30", "22:00")
  if (now.getTime() >= today830.getTime()) {
    const tomorrow830 = new Date(today830)
    tomorrow830.setDate(tomorrow830.getDate() + 1)
    assert.equal(result, tomorrow830.getTime())
  } else {
    // 本地时间尚未到今天的 08:30：endAt 应为今天。
    assert.equal(result, today830.getTime())
  }
})

test("computeEndAt keeps day-end semantics without startTime (passed end stays today)", () => {
  const past = new Date(Date.now() - 60_000)
  const endTime = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`
  const expected = new Date()
  expected.setHours(past.getHours(), past.getMinutes(), 0, 0)
  assert.equal(computeEndAt(endTime, ""), expected.getTime())
})

test("errorToMatchString includes numeric status when present", () => {
  assert.equal(errorToMatchString({ name: "AI_Error", status: 502 }), "AI_Error: (status: 502)")
  assert.equal(errorToMatchString({ name: "AI_Error", message: "bad", status: 500 }), "AI_Error: bad (status: 500)")
  assert.equal(errorToMatchString({ name: "AI_Error", status: 503 }), "AI_Error: (status: 503)")
})

test("retryHookHandler matches bare 5xx status via appended status", () => {
  const event = {
    error: { type: "AI_Error", status: 503 },
    attempt: 1,
    decision: { retry: false },
  }
  retryHookHandler(() => DEFAULT_CONFIG, event as any)
  assert.equal(event.decision.retry, true)
})

test("concurrent tryInject calls only inject once (inFlight guard)", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_9")
  // 门闩：第一次 context 调用挂起，制造两个 tryInject 交错的窗口。
  let releaseContext: () => void = () => {}
  let contextCallCount = 0
  let gateFirstContext = true
  session.context = () => {
    if (gateFirstContext) {
      gateFirstContext = false
      return new Promise<readonly unknown[]>((resolve) => {
        contextCallCount++
        releaseContext = () => resolve([])
      })
    }
    return Promise.resolve([])
  }
  const first = engine.tryInject("ses_9")
  const second = engine.tryInject("ses_9")
  assert.equal(contextCallCount, 1) // 第二个撞上 inFlight 闩锁，不会进入 context
  releaseContext()
  await Promise.all([first, second])
  assert.equal(session.prompts.length, 1)
})

// --- keep-alive heartbeat ---

test("DEFAULT_CONFIG has 1h interval and a distinct intervalMessage", () => {
  assert.equal(DEFAULT_CONFIG.intervalMs, 3_600_000)
  assert.equal(DEFAULT_CONFIG.intervalMessage, "继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。")
  assert.notEqual(DEFAULT_CONFIG.intervalMessage, DEFAULT_CONFIG.message)
})

test("mergeConfig overrides intervalMs and intervalMessage", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { intervalMs: 60_000, intervalMessage: "心跳" })
  assert.equal(merged.intervalMs, 60_000)
  assert.equal(merged.intervalMessage, "心跳")
})

test("keep-alive injects intervalMessage without incrementing consecutive", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000, maxConsecutive: 3 })
  await store.watch("ses_k1")
  await engine.tryKeepAlive("ses_k1")
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0] ?? "", /按既定计划推进/)
  const entry = store.getState("ses_k1")
  assert.equal(entry?.consecutive, 0) // heartbeat must not count toward maxConsecutive
  assert.equal(entry?.state, "watching")
  assert.equal(entry?.heartbeats, 1) // but it does count as a heartbeat
})

test("recordHeartbeat increments and heartbeats survives hydrate + status", async () => {
  const { store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_hb1")
  await store.recordHeartbeat("ses_hb1")
  await store.recordHeartbeat("ses_hb1")
  assert.equal(store.getState("ses_hb1")?.heartbeats, 2)
  // Status output must carry heartbeats (RPC schema declares it).
  assert.equal(store.status("ses_hb1").state?.heartbeats, 2)
  assert.equal(store.list()[0]?.heartbeats, 2)
  // Persist + rehydrate keeps the counter.
  await store.watch("ses_hb2")
  await store.recordHeartbeat("ses_hb2")
  await store.unwatch("ses_hb2")
  await store.watch("ses_hb2")
  // A fresh watch resets the counter.
  assert.equal(store.getState("ses_hb2")?.heartbeats, 0)
})

test("keep-alive skips while a recovery is in flight", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k2")
  store.getMemory("ses_k2").inFlight = true
  await engine.tryKeepAlive("ses_k2")
  assert.equal(session.prompts.length, 0)
})

test("keep-alive skips when the model was active within 60s", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k3")
  store.getMemory("ses_k3").lastBusyAt = Date.now() - 5_000
  await engine.tryKeepAlive("ses_k3")
  assert.equal(session.prompts.length, 0)
})

test("keep-alive stops for a session that is no longer watching", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k4")
  await store.unwatch("ses_k4")
  await engine.tryKeepAlive("ses_k4")
  assert.equal(session.prompts.length, 0)
})

// --- regression tests for review findings (P1/P2/P3 batch) ---

test("keep-alive does not inject outside the time window (P1-1)", async () => {
  // Watch with an endAt already in the past: the heartbeat must stop the
  // session instead of injecting past the window.
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k5", Date.now() - 1_000)
  await engine.tryKeepAlive("ses_k5")
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_k5")?.state, "stopped")
})

test("keep-alive holds inFlight across the completion check (P1-2)", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k6")
  // Stale pendingContinue latch must NOT block the heartbeat after the
  // retry-window grace, but a fresh one must.
  store.getMemory("ses_k6").pendingContinue = true
  store.getMemory("ses_k6").pendingContinueAt = Date.now() - 60_000
  await engine.tryKeepAlive("ses_k6")
  assert.equal(session.prompts.length, 1)
})

test("keep-alive respects a fresh pendingContinue latch (P2-8)", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k7")
  store.getMemory("ses_k7").pendingContinue = true
  store.getMemory("ses_k7").pendingContinueAt = Date.now()
  await engine.tryKeepAlive("ses_k7")
  assert.equal(session.prompts.length, 0)
})

test("hydrate normalizes legacy rows missing since/consecutive (P2-1)", async () => {
  const storage = new FakeStorage() as any
  // Simulate old-version persisted data lacking since/consecutive and carrying
  // a null lastInjectedAt (JSON round-trip of an explicit null).
  await storage.set("opencode-autocontinue.watched", {
    ses_old: { sessionID: "ses_old", state: "watching", lastInjectedAt: null },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  const state = store.status("ses_old")
  assert.equal(state.watched, true)
  assert.equal(typeof state.state?.since, "number")
  assert.equal(state.state?.consecutive, 0)
  // lastInjectedAt must be omitted (null/undefined would fail the RPC schema).
  assert.equal(state.state?.lastInjectedAt, undefined)
})

test("resolveTitle does not cache an empty title (P2-4)", async () => {
  const { session, store, engine } = await makeEngine()
  await store.watch("ses_old2")
  // First call: no title present -> no cache write, returns undefined.
  session.context = async () => [{ info: { role: "user" }, parts: [] }]
  const first = await engine.resolveTitle("ses_old2")
  assert.equal(first, undefined)
  // Second call: title now appears -> must be re-resolved (not served from a
  // poisoned "" cache).
  session.context = async () => [{ info: { role: "user", title: "测试任务" }, parts: [] }]
  const second = await engine.resolveTitle("ses_old2")
  assert.equal(second, "测试任务")
})

test("mergeConfig clamps intervalMs to a minimum of 1s (P2-7)", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { intervalMs: 10 })
  assert.equal(merged.intervalMs, 1_000)
})

test("renderMessage renders 不限 when there is no time window (P3-3)", () => {
  const text = renderMessage("剩余 {remaining}", 0)
  assert.match(text, /不限/)
})

test("default errorPatterns match 5xx via (status: 5) not bare 5 (P3-4)", () => {
  // Bare "5" is gone: a plain "5" in a message no longer counts as retryable.
  assert.equal(isRetryableError({ message: "got 5 results" }, DEFAULT_CONFIG.errorPatterns, []), false)
  // A 5xx status still matches through the "(status: 5" prefix.
  assert.equal(isRetryableError({ name: "AI_Error", status: 503 }, DEFAULT_CONFIG.errorPatterns, []), true)
})
