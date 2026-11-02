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
  idleOutcomeFromEvent,
  sessionIDFromEvent,
  isRetryableError,
  errorToMatchString,
  messageText,
  hasCompletionMarker,
  matchSentinel,
  looksIncomplete,
  titleExcluded,
} from "../src/events.ts"

test("sessionIDFromEvent handles flat and nested shapes", () => {
  assert.equal(sessionIDFromEvent({ type: "x", sessionID: "ses_flat" }), "ses_flat")
  assert.equal(sessionIDFromEvent({ type: "x", properties: { sessionID: "ses_nested" } }), "ses_nested")
  assert.equal(sessionIDFromEvent({ type: "x", data: { sessionID: "ses_data" } }), "ses_data")
  assert.equal(sessionIDFromEvent({ type: "x" }), undefined)
})

test("idleOutcomeFromEvent handles flat and nested shapes", () => {
  assert.equal(idleOutcomeFromEvent({ type: "session.idle", outcome: "interrupted" }), "interrupted")
  assert.equal(idleOutcomeFromEvent({ type: "session.idle", properties: { outcome: "interrupted" } }), "interrupted")
  assert.equal(idleOutcomeFromEvent({ type: "session.idle", data: { outcome: "interrupted" } }), "interrupted")
  assert.equal(idleOutcomeFromEvent({ type: "session.idle" }), undefined)
  assert.equal(idleOutcomeFromEvent({ type: "session.idle", outcome: 42 }), undefined)
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
import {
  renderMessage,
  injectContinuation,
  isPluginInjection,
  PROVENANCE_ORIGIN,
  PROVENANCE_KIND,
} from "../src/prompt.ts"

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
import {
  AutocontinueEngine,
  computeEndAt,
  startTimeNotReached,
  startGateClosed,
  retryHookHandler,
  selectPressureMessage,
  composeRejectionPrompt,
  matchesFrustration,
} from "../src/engine.ts"
import { WatchStore } from "../src/state.ts"
import {
  runVerification,
  verificationArgv,
  buildVerifyDetail,
  stripControlChars,
} from "../src/verify.ts"
import type { SpawnAdapter } from "../src/verify.ts"

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
  const events: Array<{
    sessionID: string
    state: string
    injections: number
    stopReason?: string
  }> = []
  const config = () => ({ ...DEFAULT_CONFIG, ...overrides })
  const engine = new AutocontinueEngine(session as any, config, store, (event) => {
    events.push({
      sessionID: event.sessionID,
      state: event.state,
      injections: event.injections,
      stopReason: event.stopReason,
    })
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

test("idle with outcome interrupted marks stopped and does not inject", async () => {
  const { session, store, engine, events } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_int1")
  await engine.handleEvent({
    type: "session.idle",
    sessionID: "ses_int1",
    outcome: "interrupted",
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(session.prompts.length, 0)
  const status = store.status("ses_int1")
  assert.equal(status.state?.state, "stopped")
  assert.ok(events.some((event) => event.sessionID === "ses_int1" && event.state === "stopped"))
})

test("idle with outcome succeeded still schedules injection", async () => {
  const { session, store, engine, events } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_ok1")
  await engine.handleEvent({
    type: "session.idle",
    sessionID: "ses_ok1",
    outcome: "succeeded",
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 1)
  assert.equal(store.status("ses_ok1").state?.state, "watching")
  assert.equal(events.some((event) => event.sessionID === "ses_ok1" && event.state === "stopped"), false)
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

test("completion marker with final check enabled runs the review round, not done", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, (event) => {
    events.push(event.state)
  })
  await store.watch("ses_4")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_4" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  // First marker triggers the final-check review injection and enters confirming.
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0] ?? "", /整体检查/)
  assert.equal(store.status("ses_4").state?.state, "confirming")
  assert.ok(events.includes("confirming"))
})

test("completion marker with a running background subagent stays watching (no done/inject)", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "主流程完成，[任务完成]" }] },
    { type: "synthetic", metadata: { source: "subagent", childID: "ses_child", agent: "fixer" } },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, (event) => {
    events.push(event.state)
  })
  await store.watch("ses_guard")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_guard" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  // Marker present but a subagent is still running: do not inject, do not
  // confirm, do not mark done — keep watching until the background work settles.
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_guard").state?.state, "watching")
  assert.ok(!events.includes("confirming"))
  assert.ok(!events.includes("done"))
})

test("completion marker with a finished background subagent confirms normally", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "全部完成，[任务完成]" }] },
    { type: "synthetic", metadata: { source: "subagent", childID: "ses_child", agent: "fixer", state: "completed" } },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, (event) => {
    events.push(event.state)
  })
  await store.watch("ses_guard2")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_guard2" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  // Subagent finished: the marker runs the normal final-check review round.
  assert.equal(session.prompts.length, 1)
  assert.equal(store.status("ses_guard2").state?.state, "confirming")
})

test("looksIncomplete detects questions, in-flight tools, and short acks", () => {
  // A: ends with a question mark — the model is asking the user.
  assert.equal(looksIncomplete("需要我继续吗？", []), true)
  assert.equal(looksIncomplete("Need more details?", []), true)
  // B: tool_use without a matching tool_result — tool execution in flight.
  assert.equal(
    looksIncomplete("正在调用工具", [{ type: "tool_use", tool: "shell" }]),
    true,
  )
  assert.equal(
    looksIncomplete("工具已返回", [
      { type: "tool_use", tool: "shell" },
      { type: "tool_result", content: "ok" },
    ]),
    false,
  )
  // C: short acknowledgement — waiting for the next instruction.
  assert.equal(looksIncomplete("好的", []), true)
  assert.equal(looksIncomplete("明白了", []), true)
  assert.equal(looksIncomplete("好的，我正在继续分析代码结构并推进。", []), false)
  // Plain progress text is not incomplete.
  assert.equal(looksIncomplete("已完成第一阶段的代码审查，共发现 3 个问题。", []), false)
})

test("looksIncomplete treats a stale non-terminal V2 tool as dead, not in flight", () => {
  // A non-terminal V2 tool with RECENT activity is still in flight — skip.
  assert.equal(
    looksIncomplete("执行中", [
      { type: "tool", name: "shell", state: { status: "streaming" }, time: { created: Date.now() - 1_000 } },
    ]),
    true,
  )
  // An ORPHANED non-terminal V2 tool (status stuck at "streaming", no advance
  // for longer than the staleness window — aborted/interrupted mid-call) is
  // DEAD. It must not lock the session so the watchdog can resume it.
  assert.equal(
    looksIncomplete("执行中", [
      { type: "tool", name: "shell", state: { status: "streaming" }, time: { created: Date.now() - 300_000 } },
    ]),
    false,
  )
  // A terminal V2 tool is not incomplete regardless of age.
  assert.equal(
    looksIncomplete("执行完成", [
      { type: "tool", name: "shell", state: { status: "completed" }, time: { created: Date.now() - 300_000 } },
    ]),
    false,
  )
})

test("idle does not inject when the model is asking a question", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "你希望我继续深入哪部分？" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_a1")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_a1" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_a1").state?.state, "watching") // still watching, not done
})

test("idle does not inject while a tool call is in flight", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "正在执行脚本" },
        { type: "tool_use", tool: "bash" },
      ],
    },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_a2")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_a2" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_a2").state?.state, "watching")
})

test("idle does not inject on a short acknowledgement", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "好的" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_a3")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_a3" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_a3").state?.state, "watching")
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

// --- v2 host message/event shape regression tests ---
// The v2 host (opencode 2.0.29) returns messages as { type, content } without
// the v1 info/parts fields, and emits differently-named events. These tests
// pin the v2 shapes so completion detection and event handling keep working
// against the real host (they used to pass with v1-shaped mocks only).

test("v2 message shape: completion marker is detected via content", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { type: "assistant", content: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, (event) => {
    events.push(event.state)
  })
  await store.watch("ses_v2_marker")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_v2_marker" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0] ?? "", /整体检查/)
  assert.equal(store.status("ses_v2_marker").state?.state, "confirming")
  assert.ok(events.includes("confirming"))
})

test("v2 message shape: question detection skips injection", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { type: "assistant", content: [{ type: "text", text: "你希望我继续深入哪部分？" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_v2_q")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_v2_q" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_v2_q").state?.state, "watching")
})

test("v2 message shape: tool_use without tool_result skips injection", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    {
      type: "assistant",
      content: [
        { type: "text", text: "正在执行脚本" },
        { type: "tool", name: "bash", state: { status: "running" } },
      ],
    },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_v2_tool")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_v2_tool" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_v2_tool").state?.state, "watching")
})

test("v2 title resolution via session.get stops watching", async () => {
  const session = makeFakeSession()
  session.context = async () => [{ type: "user", text: "hello" }]
  session.get = async () => ({ title: "测试会话" })
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_v2_title")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_v2_title" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_v2_title").state?.state, "stopped")
})

test("v2 execution.failed schedules an injection on idle", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_v2_err")
  await engine.handleEvent({
    type: "session.execution.failed",
    sessionID: "ses_v2_err",
    data: { error: { message: "bad_response_status_code" } },
  })
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_v2_err" })
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0] ?? "", /^继续执行/)
})

test("v2 inbox enqueued user message resets the round and enters grace", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5, userGraceMs: 60_000 })
  await store.watch("ses_v2_user")
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_v2_user",
    data: { item: { type: "user" } },
  })
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_v2_user" })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(session.prompts.length, 0) // inside grace -> rescheduled, not injected
})

test("v2 execution.interrupted marks stopped and does not inject", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_v2_stop")
  await engine.handleEvent({ type: "session.execution.interrupted", sessionID: "ses_v2_stop" })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(session.prompts.length, 0)
  assert.equal(store.status("ses_v2_stop").state?.state, "stopped")
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

test("concurrent maybeInject calls only inject once (inFlight guard)", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_9")
  // 门闩：第一次 context 调用挂起，制造两个 maybeInject 交错的窗口。
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
  const first = engine.maybeInject("ses_9")
  const second = engine.maybeInject("ses_9")
  assert.equal(contextCallCount, 1) // 第二个撞上 inFlight 闩锁，不会进入 context
  releaseContext()
  await Promise.all([first, second])
  assert.equal(session.prompts.length, 1)
})

// --- unified injection (periodic checks) ---

test("DEFAULT_CONFIG has 1h interval and a final check enabled by default", () => {
  assert.equal(DEFAULT_CONFIG.intervalMs, 3_600_000)
  assert.equal(DEFAULT_CONFIG.finalCheckEnabled, true)
  assert.match(DEFAULT_CONFIG.finalCheckMessage, /整体检查/)
  // P3: the unattended guardrails now have finite defaults — 24h watch budget
  // and 50 verification rounds. 0 still means "unlimited" when set explicitly.
  assert.equal(DEFAULT_CONFIG.watchTimeoutMs, 86_400_000)
  assert.equal(DEFAULT_CONFIG.verifyMaxIterations, 50)
})

test("DEFAULT_CONFIG ships the frustration trigger disabled with its default message", () => {
  // P2: an empty trigger list keeps the feature off — a false positive would
  // push a rebuke into a normal round.
  assert.deepEqual(DEFAULT_CONFIG.frustrationTriggers, [])
  assert.equal(
    DEFAULT_CONFIG.frustrationMessage,
    "用户明确表达了对质量的不满：换本质不同的方法重新推进，并贴出可核对的验证证据（命令 + 输出），不要只改措辞。",
  )
})

test("mergeConfig overrides intervalMs and finalCheck settings", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    intervalMs: 60_000,
    finalCheckEnabled: false,
    finalCheckMessage: "复查",
    watchTimeoutMs: 7_200_000,
  })
  assert.equal(merged.intervalMs, 60_000)
  assert.equal(merged.finalCheckEnabled, false)
  assert.equal(merged.finalCheckMessage, "复查")
  assert.equal(merged.watchTimeoutMs, 7_200_000)
})

test("maybeInject injects the unified message and counts one injection", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000, maxConsecutive: 3 })
  await store.watch("ses_k1")
  await engine.maybeInject("ses_k1")
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0] ?? "", /按既定计划推进/)
  const entry = store.getState("ses_k1")
  assert.equal(entry?.state, "watching")
  assert.equal(entry?.injections, 1)
})

test("injections survive hydrate + status + list", async () => {
  const { store } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_hb1")
  await store.recordInjection("ses_hb1")
  await store.recordInjection("ses_hb1")
  assert.equal(store.getState("ses_hb1")?.injections, 2)
  assert.equal(store.status("ses_hb1").state?.injections, 2)
  assert.equal(store.list()[0]?.injections, 2)
  // A fresh watch resets the counter.
  await store.watch("ses_hb2")
  await store.recordInjection("ses_hb2")
  await store.unwatch("ses_hb2")
  await store.watch("ses_hb2")
  assert.equal(store.getState("ses_hb2")?.injections, 0)
})

test("maybeInject emitChanged carries the injection count (regression)", async () => {
  const { session, store, engine, events } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_hb3")
  await engine.maybeInject("ses_hb3")
  assert.equal(session.prompts.length, 1)
  assert.equal(store.getState("ses_hb3")?.injections, 1)
  // The state.changed event (which the TUI uses to refresh the sidebar) must
  // carry the fresh injection count — otherwise the TUI would overwrite its
  // local counter back to 0 on every periodic injection.
  const last = events[events.length - 1]
  assert.equal(last?.sessionID, "ses_hb3")
  assert.equal(last?.state, "watching")
  assert.equal(last?.injections, 1)
})

test("maybeInject skips while a recovery is in flight", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k2")
  store.getMemory("ses_k2").inFlight = true
  await engine.maybeInject("ses_k2")
  assert.equal(session.prompts.length, 0)
})

test("maybeInject skips when the model was active within 60s", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k3")
  store.getMemory("ses_k3").lastBusyAt = Date.now() - 5_000
  await engine.maybeInject("ses_k3")
  assert.equal(session.prompts.length, 0)
})

test("maybeInject skips while the session is actively running/streaming", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000, idleDelayMs: 60_000 })
  await store.watch("ses_k3r")
  // A live run (execution/step event) just refreshed lastActiveAt.
  store.getMemory("ses_k3r").lastActiveAt = Date.now()
  await engine.maybeInject("ses_k3r")
  assert.equal(session.prompts.length, 0)
})

test("maybeInject proceeds once the running session settles", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000, idleDelayMs: 5 })
  await store.watch("ses_k3s")
  // lastActiveAt lapsed past the idleDelayMs grace — the run has settled.
  store.getMemory("ses_k3s").lastActiveAt = Date.now() - 60_000
  await engine.maybeInject("ses_k3s")
  assert.equal(session.prompts.length, 1)
})

test("execution.started / step.started / step.streamed events refresh lastActiveAt", async () => {
  const { store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k3e")
  await engine.handleEvent({ type: "session.execution.started", sessionID: "ses_k3e", data: { sessionID: "ses_k3e" } })
  assert.ok(store.getMemory("ses_k3e").lastActiveAt > 0)
  store.getMemory("ses_k3e").lastActiveAt = 0
  await engine.handleEvent({ type: "session.step.streamed", sessionID: "ses_k3e", data: { sessionID: "ses_k3e" } })
  assert.ok(store.getMemory("ses_k3e").lastActiveAt > 0)
})

test("maybeInject stops for a session that is no longer watching", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k4")
  await store.unwatch("ses_k4")
  await engine.maybeInject("ses_k4")
  assert.equal(session.prompts.length, 0)
})

test("maybeInject does not inject outside the time window (P1-1)", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k5", Date.now() - 1_000)
  await engine.maybeInject("ses_k5")
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_k5")?.state, "stopped")
})

test("fresh pendingContinue is consumed by the idle path (P2-8)", async () => {
  // In the unified architecture the pendingContinue latch is consumed by the
  // session.idle event handler (which schedules a delayed maybeInject); the
  // interval-triggered maybeInject itself no longer reads it — the inFlight
  // lock already prevents double injection.
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_k7")
  store.getMemory("ses_k7").pendingContinue = true
  store.getMemory("ses_k7").pendingContinueAt = Date.now()
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_k7" })
  // The pendingContinue branch schedules with Math.max(idleDelayMs, 1000).
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.equal(session.prompts.length, 1)
  assert.equal(store.getMemory("ses_k7").pendingContinue, false) // consumed
})

test("completion marker with final check injects the review message then confirms", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, (event) => {
    events.push(event.state)
  })
  await store.watch("ses_fc1")
  await engine.maybeInject("ses_fc1")
  // First marker: injects finalCheckMessage, moves to confirming, does NOT mark done.
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0] ?? "", /整体检查/)
  assert.equal(store.getState("ses_fc1")?.state, "confirming")
  assert.equal(store.getState("ses_fc1")?.injections, 1)
})

test("second completion marker while confirming marks done", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, (event) => {
    events.push(event.state)
  })
  await store.watch("ses_fc2")
  await store.beginConfirming("ses_fc2")
  await engine.maybeInject("ses_fc2")
  // Second marker: done, no new injection.
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_fc2")?.state, "done")
  assert.ok(events.includes("done"))
})

test("completion marker with final check disabled marks done immediately", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(
    session as any,
    () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5, finalCheckEnabled: false }),
    store,
    (event) => events.push(event.state),
  )
  await store.watch("ses_fc3")
  await engine.maybeInject("ses_fc3")
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_fc3")?.state, "done")
  assert.ok(events.includes("done"))
})

test("watchTimeoutMs stops the round after the budget", async () => {
  const { session, store, engine, events } = await makeEngine({ intervalMs: 60_000, watchTimeoutMs: 5_000 })
  // Start the watch 10s ago so the budget is already exceeded.
  const store2 = store
  await store2.watch("ses_wt1")
  const entry = store2.getState("ses_wt1")
  if (entry) entry.since = Date.now() - 10_000
  await engine.maybeInject("ses_wt1")
  assert.equal(session.prompts.length, 0)
  assert.equal(store2.getState("ses_wt1")?.state, "stopped")
  assert.ok(events.some((event) => event.state === "stopped"))
})

test("hydrate normalizes legacy rows missing since/injections (P2-1)", async () => {
  const storage = new FakeStorage() as any
  // Simulate old-version persisted data lacking since/injections and carrying
  // a null lastInjectedAt (JSON round-trip of an explicit null). Legacy
  // consecutive+heartbeats must fold into injections.
  await storage.set("opencode-autocontinue.watched", {
    ses_old: { sessionID: "ses_old", state: "watching", consecutive: 2, heartbeats: 3, lastInjectedAt: null },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  const state = store.status("ses_old")
  assert.equal(state.watched, true)
  assert.equal(typeof state.state?.since, "number")
  assert.equal(state.state?.injections, 5) // 2 consecutive + 3 heartbeats folded
  // lastInjectedAt must be omitted (null/undefined would fail the RPC schema).
  assert.equal(state.state?.lastInjectedAt, undefined)
})

test("hydrate drops persisted terminal rows and keeps active watches", async () => {
  const storage = new FakeStorage() as any
  // done/stopped rows are round-end feedback for the run that just ended —
  // restoring them made every previously watched session report watched=true
  // forever (the sidebar "Watch" block shown by default). Only active rows
  // (watching/confirming) may survive a restart.
  await storage.set("opencode-autocontinue.watched", {
    ses_finished: { sessionID: "ses_finished", state: "done", injections: 2, since: 1000, endAt: 0 },
    ses_halted: { sessionID: "ses_halted", state: "stopped", injections: 1, since: 1000, endAt: 0 },
    ses_midwatch: { sessionID: "ses_midwatch", state: "watching", injections: 0, since: 1000, endAt: 0 },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  assert.equal(store.status("ses_finished").watched, false)
  assert.equal(store.status("ses_halted").watched, false)
  assert.equal(store.status("ses_midwatch").watched, true)
  assert.equal(store.status("ses_midwatch").state?.state, "watching")
})

test("hydrate-dropped terminal rows are not re-persisted by a later save", async () => {
  const storage = new FakeStorage() as any
  await storage.set("opencode-autocontinue.watched", {
    ses_finished: { sessionID: "ses_finished", state: "done", injections: 2, since: 1000, endAt: 0 },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  // Any later persist() (here: a fresh watch) must rewrite storage from the
  // in-memory map — the dropped terminal row must not come back.
  await store.watch("ses_newwatch")
  const snapshot = (await storage.get("opencode-autocontinue.watched")) as Record<string, unknown>
  assert.equal("ses_finished" in snapshot, false)
  assert.equal("ses_newwatch" in snapshot, true)
})

// --- regression tests for review findings (P1/P2/P3 batch) ---

test("maybeInject holds inFlight across the completion check (P1-2)", async () => {
  const { session, store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_k6")
  // Stale pendingContinue latch must NOT block the injection after the
  // retry-window grace, but a fresh one must.
  store.getMemory("ses_k6").pendingContinue = true
  store.getMemory("ses_k6").pendingContinueAt = Date.now() - 60_000
  await engine.maybeInject("ses_k6")
  assert.equal(session.prompts.length, 1)
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

test("mergeConfig keeps intervalMs 0 to disable periodic checks", () => {
  // The doc contract (intervalMs: 0 = disabled) must survive the P2-7 floor:
  // only positive values clamp to 1s; 0 passes through so scheduleInterval's
  // `<= 0` disable path is reachable from config.
  const merged = mergeConfig(DEFAULT_CONFIG, { intervalMs: 0 })
  assert.equal(merged.intervalMs, 0)
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

test("confirming does not mark done while the old marker message is still latest (B1)", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(
    session as any,
    () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5, minIntervalMs: 0 }),
    store,
    (event) => {
      events.push(event.state)
    },
  )
  await store.watch("ses_b1")
  // First idle: first marker enters confirming and injects the review message.
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_b1" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(store.status("ses_b1").state?.state, "confirming")
  const promptsAfterFirst = session.prompts.length
  // Second idle with the SAME latest assistant message (no review reply yet):
  // must NOT mark done and must NOT inject again.
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_b1" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(store.status("ses_b1").state?.state, "confirming")
  assert.equal(session.prompts.length, promptsAfterFirst)
  assert.ok(!events.includes("done"))
})

test("confirming review reply without marker returns to watching (B2)", async () => {
  const messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> = [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const session = makeFakeSession()
  session.context = async () => messages
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(
    session as any,
    () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5, minIntervalMs: 0 }),
    store,
    (event) => {
      events.push(event.state)
    },
  )
  await store.watch("ses_b2")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_b2" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(store.status("ses_b2").state?.state, "confirming")
  const injectionsWhileConfirming = store.status("ses_b2").state?.injections
  // Model replies with a NEW assistant message carrying no completion marker.
  messages.push({ info: { role: "assistant" }, parts: [{ type: "text", text: "整体检查完毕，发现还有 3 个问题需要继续处理。" }] })
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_b2" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(store.status("ses_b2").state?.state, "watching")
  assert.equal(store.status("ses_b2").state?.injections, injectionsWhileConfirming)
  assert.ok(events.includes("watching"))
})

test("confirming second marker in a NEW assistant message marks done (B1 positive)", async () => {
  const messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> = [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成，[任务完成]" }] },
  ]
  const session = makeFakeSession()
  session.context = async () => messages
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(
    session as any,
    () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5, minIntervalMs: 0 }),
    store,
    (event) => {
      events.push(event.state)
    },
  )
  await store.watch("ses_b3")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_b3" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(store.status("ses_b3").state?.state, "confirming")
  // Model replies affirming the overall check is complete.
  messages.push({ info: { role: "assistant" }, parts: [{ type: "text", text: "复查完毕，[任务完成]。" }] })
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_b3" })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(store.status("ses_b3").state?.state, "done")
  assert.ok(events.includes("done"))
})

// --- #1 injection provenance ---
// Our own injected continuation must never be mistaken for a real user message
// (which would resume the round and zero the injection counter), and the
// injection helper must prefer the structurally-distinct synthetic channel.

test("isPluginInjection recognizes only our provenance origin", () => {
  assert.equal(isPluginInjection(undefined), false)
  assert.equal(isPluginInjection(null), false)
  assert.equal(isPluginInjection({}), false)
  assert.equal(isPluginInjection("opencode-autocontinue"), false)
  assert.equal(isPluginInjection({ origin: "someone-else" }), false)
  assert.equal(isPluginInjection({ origin: PROVENANCE_ORIGIN }), true)
  assert.equal(isPluginInjection({ origin: PROVENANCE_ORIGIN, kind: PROVENANCE_KIND }), true)
})

test("injectContinuation prefers session.synthetic with provenance metadata", async () => {
  let syntheticInput: any
  let promptInput: any
  const session = {
    async synthetic(input: any) {
      syntheticInput = input
    },
    async prompt(input: any) {
      promptInput = input
    },
  }
  await injectContinuation(session, "ses_syn", "继续 {time}", 0)
  assert.equal(syntheticInput?.sessionID, "ses_syn")
  assert.match(syntheticInput?.text ?? "", /^继续 /)
  assert.equal(syntheticInput?.resume, true)
  assert.equal(isPluginInjection(syntheticInput?.metadata), true)
  assert.equal(promptInput, undefined)
})

test("injectContinuation falls back to prompt with provenance when synthetic is absent", async () => {
  let promptInput: any
  const session = {
    async prompt(input: any) {
      promptInput = input
    },
  }
  await injectContinuation(session, "ses_fb", "继续", 0)
  assert.equal(promptInput?.sessionID, "ses_fb")
  assert.equal(promptInput?.text, "继续")
  assert.equal(isPluginInjection(promptInput?.metadata), true)
})

test("injectContinuation falls back to prompt with provenance when synthetic throws", async () => {
  let promptInput: any
  const session = {
    async synthetic() {
      throw new Error("synthetic unsupported")
    },
    async prompt(input: any) {
      promptInput = input
    },
  }
  await injectContinuation(session, "ses_throw", "继续", 0)
  assert.equal(promptInput?.sessionID, "ses_throw")
  assert.equal(isPluginInjection(promptInput?.metadata), true)
})

/** Put a session mid-round (2 injections, confirming) so a resume() that
 *  zeroes the counter / flips to watching is observable. */
async function armSessionMidRound(store: WatchStore, sessionID: string) {
  await store.watch(sessionID)
  await store.recordInjection(sessionID)
  await store.recordInjection(sessionID)
  await store.beginConfirming(sessionID)
}

test("real user message without metadata resets the round", async () => {
  const { store, engine } = await makeEngine()
  await armSessionMidRound(store, "ses_prov_real")
  await engine.handleEvent({
    type: "message.updated",
    sessionID: "ses_prov_real",
    properties: { info: { role: "user" } },
  })
  const status = store.status("ses_prov_real")
  assert.equal(status.state?.state, "watching")
  assert.equal(status.state?.injections, 0)
})

test("inbox user message without metadata resets the round", async () => {
  const { store, engine } = await makeEngine()
  await armSessionMidRound(store, "ses_prov_inbox_real")
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_prov_inbox_real",
    data: { item: { type: "user" } },
  })
  const status = store.status("ses_prov_inbox_real")
  assert.equal(status.state?.state, "watching")
  assert.equal(status.state?.injections, 0)
})

test("plugin injection as type user does not reset the round", async () => {
  const { store, engine } = await makeEngine()
  await armSessionMidRound(store, "ses_prov_user")
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_prov_user",
    data: {
      item: { type: "user", metadata: { origin: PROVENANCE_ORIGIN, kind: PROVENANCE_KIND } },
    },
  })
  const status = store.status("ses_prov_user")
  assert.equal(status.state?.state, "confirming")
  assert.equal(status.state?.injections, 2)
  assert.equal(store.getMemory("ses_prov_user").lastUserMessageAt, 0)
})

test("plugin injection as synthetic does not reset the round", async () => {
  const { store, engine } = await makeEngine()
  await armSessionMidRound(store, "ses_prov_syn")
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_prov_syn",
    data: {
      item: { type: "synthetic", metadata: { origin: PROVENANCE_ORIGIN, kind: PROVENANCE_KIND } },
    },
  })
  const status = store.status("ses_prov_syn")
  assert.equal(status.state?.state, "confirming")
  assert.equal(status.state?.injections, 2)
})

test("message.updated user info with provenance does not reset the round", async () => {
  const { store, engine } = await makeEngine()
  await armSessionMidRound(store, "ses_prov_info")
  await engine.handleEvent({
    type: "message.updated",
    sessionID: "ses_prov_info",
    properties: { info: { role: "user", metadata: { origin: PROVENANCE_ORIGIN } } },
  })
  const status = store.status("ses_prov_info")
  assert.equal(status.state?.state, "confirming")
  assert.equal(status.state?.injections, 2)
  assert.equal(store.getMemory("ses_prov_info").lastUserMessageAt, 0)
})

test("plugin injection via item.payload.metadata does not reset the round (installed host)", async () => {
  const { store, engine } = await makeEngine()
  await armSessionMidRound(store, "ses_prov_payload")
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_prov_payload",
    data: {
      item: {
        type: "user",
        payload: { metadata: { origin: PROVENANCE_ORIGIN, kind: PROVENANCE_KIND } },
      },
    },
  })
  const status = store.status("ses_prov_payload")
  assert.equal(status.state?.state, "confirming")
  assert.equal(status.state?.injections, 2)
  assert.equal(store.getMemory("ses_prov_payload").lastUserMessageAt, 0)
})

test("plugin injection via info.payload.metadata does not reset the round", async () => {
  const { store, engine } = await makeEngine()
  await armSessionMidRound(store, "ses_prov_info_payload")
  await engine.handleEvent({
    type: "message.updated",
    sessionID: "ses_prov_info_payload",
    properties: {
      info: { role: "user", payload: { metadata: { origin: PROVENANCE_ORIGIN } } },
    },
  })
  const status = store.status("ses_prov_info_payload")
  assert.equal(status.state?.state, "confirming")
  assert.equal(status.state?.injections, 2)
  assert.equal(store.getMemory("ses_prov_info_payload").lastUserMessageAt, 0)
})

// --- #2.3 self-echo fallback ---

test("self-echo: our own injected text returning as a plain user message is ignored", async () => {
  const { session, store, engine } = await makeEngine({
    intervalMs: 60_000,
    selfEchoWindowMs: 10_000,
  })
  await store.watch("ses_echo_plain")
  await engine.maybeInject("ses_echo_plain")
  assert.equal(session.prompts.length, 1)
  const injectedText = session.prompts[0]
  // Feed the exact text back as an inbox user item WITHOUT metadata.
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_echo_plain",
    data: { item: { type: "user", payload: { text: injectedText } } },
  })
  assert.equal(store.status("ses_echo_plain").state?.injections, 1) // not zeroed
  assert.equal(store.getMemory("ses_echo_plain").lastUserMessageAt, 0)
  // A DIFFERENT message (record already consumed) is a real user turn.
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_echo_plain",
    data: { item: { type: "user", payload: { text: "我改主意了，停一下" } } },
  })
  assert.equal(store.status("ses_echo_plain").state?.injections, 0)
})

test("self-echo: provenance metadata marks our injection even without a text match", async () => {
  const { store, engine } = await makeEngine({ selfEchoWindowMs: 10_000 })
  await armSessionMidRound(store, "ses_echo_meta")
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_echo_meta",
    data: {
      item: { type: "user", payload: { metadata: { origin: PROVENANCE_ORIGIN }, text: "任意内容" } },
    },
  })
  assert.equal(store.status("ses_echo_meta").state?.state, "confirming")
  assert.equal(store.status("ses_echo_meta").state?.injections, 2)
})

// --- #3 verify module ---

test("verificationArgv uses PowerShell on win32 and /bin/sh elsewhere", () => {
  assert.deepEqual(verificationArgv("echo hi", "win32"), [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "echo hi",
  ])
  assert.deepEqual(verificationArgv("echo hi", "linux"), ["/bin/sh", "-c", "echo hi"])
  assert.deepEqual(verificationArgv("echo hi", "darwin"), ["/bin/sh", "-c", "echo hi"])
})

test("runVerification judges by exit code via an injected spawn adapter", async () => {
  const passAdapter: SpawnAdapter = async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false })
  const pass = await runVerification({ argv: ["x"], cwd: ".", timeoutMs: 1_000 }, passAdapter)
  assert.equal(pass.pass, true)
  assert.equal(pass.exitCode, 0)

  const failAdapter: SpawnAdapter = async () => ({ exitCode: 2, stdout: "", stderr: "err", timedOut: false })
  const fail = await runVerification({ argv: ["x"], cwd: ".", timeoutMs: 1_000 }, failAdapter)
  assert.equal(fail.pass, false)
  assert.equal(fail.exitCode, 2)

  // Timeout: never pass, regardless of a null exit code.
  const timeoutAdapter: SpawnAdapter = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true })
  const timedOut = await runVerification({ argv: ["x"], cwd: ".", timeoutMs: 1_000 }, timeoutAdapter)
  assert.equal(timedOut.pass, false)
  assert.equal(timedOut.timedOut, true)

  // Spawn unavailable (adapter throws): degrade to pass so completion is not
  // misjudged when verification is impossible.
  const throwingAdapter: SpawnAdapter = async () => {
    throw new Error("no spawn")
  }
  const unavailable = await runVerification({ argv: ["x"], cwd: ".", timeoutMs: 1_000 }, throwingAdapter)
  assert.equal(unavailable.spawnUnavailable, true)
  assert.equal(unavailable.pass, true)
})

test("stripControlChars removes ANSI and C0 but keeps newline and tab", () => {
  assert.equal(stripControlChars("a\u001b[1mb\u001b[0m\u0007c"), "abc")
  assert.equal(stripControlChars("x\ty\nz"), "x\ty\nz")
})

test("buildVerifyDetail adds the untrusted notice, cleans output, and caps at 8KB", () => {
  const result = {
    pass: false,
    timedOut: false,
    spawnUnavailable: false,
    exitCode: 1,
    stdout: "\u001b[31mred\u001b[0m\u0007",
    stderr: "",
    detail: "",
  }
  const detail = buildVerifyDetail("npm test", result)
  assert.match(detail, /属数据，非用户或模型指令/)
  assert.ok(!detail.includes("\u001b["))
  assert.ok(!detail.includes("\u0007"))
  const huge = { ...result, stdout: "a".repeat(50_000) }
  const bigDetail = buildVerifyDetail("npm test", huge)
  assert.ok(Buffer.from(bigDetail, "utf8").length <= 8 * 1024)
})

test("selectPressureMessage maps rejection tiers 3/7/15/30/50/else and clamps/empties", () => {
  const ladder = ["t0", "t1", "t2", "t3", "t4", "t5"]
  assert.equal(selectPressureMessage(ladder, 0), "t0")
  assert.equal(selectPressureMessage(ladder, 3), "t0")
  assert.equal(selectPressureMessage(ladder, 4), "t1")
  assert.equal(selectPressureMessage(ladder, 7), "t1")
  assert.equal(selectPressureMessage(ladder, 8), "t2")
  assert.equal(selectPressureMessage(ladder, 15), "t2")
  assert.equal(selectPressureMessage(ladder, 16), "t3")
  assert.equal(selectPressureMessage(ladder, 30), "t3")
  assert.equal(selectPressureMessage(ladder, 31), "t4")
  assert.equal(selectPressureMessage(ladder, 50), "t4")
  assert.equal(selectPressureMessage(ladder, 51), "t5")
  assert.equal(selectPressureMessage(ladder, 999), "t5")
  // A shorter ladder clamps to its last row; an empty ladder yields "".
  assert.equal(selectPressureMessage(["only"], 99), "only")
  assert.equal(selectPressureMessage([], 5), "")
})

test("composeRejectionPrompt layers message, pressure, reassess and root cause", () => {
  const atZero = composeRejectionPrompt({ ...DEFAULT_CONFIG, escalationPressureLadder: [] }, 0)
  assert.equal(atZero, `${DEFAULT_CONFIG.message}\n🚫 验证未通过（连续第 0 次）。`)
  const atThree = composeRejectionPrompt({ ...DEFAULT_CONFIG, escalationPressureLadder: [] }, 3)
  assert.ok(atThree.includes(DEFAULT_CONFIG.escalationReassessMessage))
  assert.ok(!atThree.includes(DEFAULT_CONFIG.escalationRootCauseMessage))
  const atFive = composeRejectionPrompt({ ...DEFAULT_CONFIG, escalationPressureLadder: [] }, 5)
  assert.ok(atFive.includes(DEFAULT_CONFIG.escalationReassessMessage))
  assert.ok(atFive.includes(DEFAULT_CONFIG.escalationRootCauseMessage))
  // With the default ladder a pressure row is always present.
  const withLadder = composeRejectionPrompt(DEFAULT_CONFIG, 1)
  assert.ok(withLadder.includes(DEFAULT_CONFIG.escalationPressureLadder[0] ?? ""))
})

test("doneSentinel is part of the default completion markers", () => {
  const matcher = buildCompletionMatcher(DEFAULT_CONFIG)
  assert.ok(matcher?.test("收尾 <promise>LOOP_DONE</promise>"))
})

test("mergeConfig clamps verify keys and merges the new escalation keys", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, {
    verifyCommand: "npm test",
    verifyTimeoutMs: 10,
    verifyMaxIterations: -3,
    escalationPressureLadder: ["only"],
    escalationReassessMessage: "re",
    escalationRootCauseMessage: "rc",
    abortSentinelTag: "",
    pauseSentinelTag: "my-pause",
    observeToolFailures: true,
  })
  assert.equal(merged.verifyCommand, "npm test")
  assert.equal(merged.verifyTimeoutMs, 1_000)
  assert.equal(merged.verifyMaxIterations, 0)
  assert.deepEqual(merged.escalationPressureLadder, ["only"])
  assert.equal(merged.escalationReassessMessage, "re")
  assert.equal(merged.escalationRootCauseMessage, "rc")
  assert.equal(merged.abortSentinelTag, "") // empty disables the sentinel
  assert.equal(merged.pauseSentinelTag, "my-pause")
  assert.equal(merged.observeToolFailures, true)
  assert.equal(mergeConfig(DEFAULT_CONFIG, {}).selfEchoWindowMs, 10_000)
})

test("mergeConfig defaults for the new keys and clamps upper bounds", () => {
  const defaults = mergeConfig(DEFAULT_CONFIG, {})
  assert.equal(defaults.abortSentinelTag, "loop-abort")
  assert.equal(defaults.pauseSentinelTag, "loop-pause")
  assert.equal(defaults.escalationPressureLadder.length, 6)
  assert.deepEqual(defaults.escalationPressureLadder, DEFAULT_CONFIG.escalationPressureLadder)
  assert.equal(defaults.observeToolFailures, false)
  // Upper bounds mirror the lower-bound clamps.
  assert.equal(mergeConfig(DEFAULT_CONFIG, { verifyTimeoutMs: 9_999_999 }).verifyTimeoutMs, 3_600_000)
  assert.equal(mergeConfig(DEFAULT_CONFIG, { verifyMaxIterations: 99_999 }).verifyMaxIterations, 10_000)
})

// --- #3.4 verify gate ---

function passVerifyResult() {
  return { pass: true, timedOut: false, spawnUnavailable: false, exitCode: 0, stdout: "", stderr: "", detail: "" }
}

function failVerifyResult(exitCode = 1) {
  return {
    pass: false,
    timedOut: false,
    spawnUnavailable: false,
    exitCode,
    stdout: "boom",
    stderr: "",
    detail: "",
  }
}

async function makeVerifyEngine(
  contextMessages: () => Promise<readonly unknown[]>,
  verifyRunner: (spec: any) => Promise<any>,
  overrides: Partial<typeof DEFAULT_CONFIG> = {},
  baseDirectory?: string,
) {
  const session = makeFakeSession()
  session.context = contextMessages as any
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: Array<{
    sessionID: string
    state: string
    injections: number
    rejections?: number
    verifying?: boolean
    stopReason?: string
  }> = []
  const config = () => ({ ...DEFAULT_CONFIG, verifyCommand: "node --version", ...overrides })
  const engine = new AutocontinueEngine(
    session as any,
    config,
    store,
    (event) => {
      events.push({
        sessionID: event.sessionID,
        state: event.state,
        injections: event.injections,
        rejections: event.rejections,
        verifying: event.verifying,
        stopReason: event.stopReason,
      })
    },
    verifyRunner,
    baseDirectory,
  )
  return { session, store, engine, events }
}

test("verify gate: no completion signal does not run verification (B-2)", async () => {
  let verifyCalls = 0
  const { session, store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "还在推进中" }] }],
    async () => {
      verifyCalls += 1
      return passVerifyResult()
    },
    { minIntervalMs: 0 },
  )
  await store.watch("ses_gate_none")
  await engine.maybeInject("ses_gate_none")
  assert.equal(verifyCalls, 0)
  assert.equal(session.prompts.length, 1) // ordinary continuation injected
  assert.equal(store.getState("ses_gate_none")?.state, "watching")
})

test("verify gate: completion signal runs verification and pass marks done", async () => {
  const specs: any[] = []
  const { store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async (spec) => {
      specs.push(spec)
      return passVerifyResult()
    },
    { minIntervalMs: 0 },
  )
  await store.watch("ses_gate_pass")
  await engine.maybeInject("ses_gate_pass")
  assert.equal(specs.length, 1)
  assert.equal(specs[0]?.argv?.[0], process.platform === "win32" ? "powershell.exe" : "/bin/sh")
  assert.equal(store.getState("ses_gate_pass")?.state, "done")
})

test("verify gate: cwd uses verifyCwd, else the project base directory", async () => {
  // An explicit verifyCwd wins over the base directory.
  const explicitSpecs: any[] = []
  const explicit = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async (spec) => {
      explicitSpecs.push(spec)
      return passVerifyResult()
    },
    { minIntervalMs: 0, verifyCwd: "explicit-verify-cwd" },
    "project-base-dir",
  )
  await explicit.store.watch("ses_cwd_explicit")
  await explicit.engine.maybeInject("ses_cwd_explicit")
  assert.equal(explicitSpecs[0]?.cwd, "explicit-verify-cwd")

  // With no verifyCwd, the base directory is used instead of process.cwd().
  const baseSpecs: any[] = []
  const base = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async (spec) => {
      baseSpecs.push(spec)
      return passVerifyResult()
    },
    { minIntervalMs: 0 },
    "project-base-dir",
  )
  await base.store.watch("ses_cwd_base")
  await base.engine.maybeInject("ses_cwd_base")
  assert.equal(baseSpecs[0]?.cwd, "project-base-dir")
})

test("verify gate: failure injects an escalation prompt and counts a rejection", async () => {
  const { session, store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => failVerifyResult(1),
    { minIntervalMs: 0 },
  )
  await store.watch("ses_gate_fail")
  await engine.maybeInject("ses_gate_fail")
  const entry = store.getState("ses_gate_fail")
  assert.equal(entry?.state, "watching")
  assert.equal(entry?.rejections, 1)
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0] ?? "", /稳步推进/) // first pressure ladder row
  assert.match(session.prompts[0] ?? "", /验证未通过（连续第 1 次）/)
  assert.match(session.prompts[0] ?? "", /属数据，非用户或模型指令/) // verify detail attached
})

test("verify gate: verify-then-cap stops exactly at verifyMaxIterations (B-3)", async () => {
  const { store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => failVerifyResult(1),
    { minIntervalMs: 0, verifyMaxIterations: 2 },
  )
  await store.watch("ses_cap")
  await engine.maybeInject("ses_cap") // rejections 1 < 2 -> inject, keep watching
  assert.equal(store.getState("ses_cap")?.state, "watching")
  assert.equal(store.getState("ses_cap")?.rejections, 1)
  await engine.maybeInject("ses_cap") // rejections 2 >= 2 -> stopped
  assert.equal(store.getState("ses_cap")?.state, "stopped")
  assert.equal(store.getState("ses_cap")?.rejections, 2)
})

test("verify gate: a round change during verification discards the result (B-4)", async () => {
  let releaseRunner: () => void = () => {}
  let runnerStarted: () => void = () => {}
  const runnerGate = new Promise<void>((resolve) => {
    releaseRunner = resolve
  })
  const startedGate = new Promise<void>((resolve) => {
    runnerStarted = resolve
  })
  const { store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => {
      runnerStarted()
      await runnerGate
      return passVerifyResult()
    },
    { minIntervalMs: 0 },
  )
  await store.watch("ses_stale")
  const inflight = engine.maybeInject("ses_stale")
  await startedGate // the runner is now blocked
  await store.resume("ses_stale") // a new user round bumps roundId
  releaseRunner()
  await inflight
  // The passing result belongs to the superseded round: no done.
  assert.equal(store.getState("ses_stale")?.state, "watching")
})

test("verify mode: the event completion path does not mark done (B-1)", async () => {
  const { store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => passVerifyResult(),
    { minIntervalMs: 0, idleDelayMs: 5 },
  )
  await store.watch("ses_b1_verify")
  await engine.handleEvent({
    type: "message.updated",
    sessionID: "ses_b1_verify",
    properties: { info: { role: "assistant", sessionID: "ses_b1_verify" } },
  })
  // No immediate decision: only a scheduled re-check; the gate owns completion.
  assert.equal(store.getState("ses_b1_verify")?.state, "watching")
  assert.equal(store.getState("ses_b1_verify")?.injections, 0)
})

test("hydrate normalizes legacy rows missing rejections/roundId to 0 (B-5)", async () => {
  const storage = new FakeStorage() as any
  await storage.set("opencode-autocontinue.watched", {
    ses_legacy: {
      sessionID: "ses_legacy",
      state: "watching",
      injections: 1,
      totalInjections: 1,
      since: 1_000,
      endAt: 0,
    },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  const entry = store.getState("ses_legacy")
  assert.equal(entry?.rejections, 0)
  assert.equal(entry?.roundId, 0)
  assert.equal(Number.isNaN(entry?.rejections), false)
  assert.equal(Number.isNaN(entry?.roundId), false)
})

// --- ② abort / pause sentinels + paused state ---

test("matchSentinel extracts a paired non-empty inner text", () => {
  assert.equal(matchSentinel("before <loop-abort>stop now</loop-abort> after", "loop-abort"), "stop now")
  // The tag is regex-escaped and matched literally.
  assert.equal(matchSentinel("<loop-pause>need a.b input</loop-pause>", "loop-pause"), "need a.b input")
  // An empty tag disables matching.
  assert.equal(matchSentinel("<loop-abort>stop</loop-abort>", ""), undefined)
  // An unmatched opening tag (no close) is not a hit.
  assert.equal(matchSentinel("no close <loop-abort>stop", "loop-abort"), undefined)
  // An empty pair is not a hit (non-empty `+?` requirement).
  assert.equal(matchSentinel("<loop-pause></loop-pause>", "loop-pause"), undefined)
  // Case-sensitive: the uppercase tag does not match the lowercase pattern.
  assert.equal(matchSentinel("<LOOP-ABORT>stop</LOOP-ABORT>", "loop-abort"), undefined)
})

test("abort sentinel marks stopped and does not inject", async () => {
  const { session, store, engine, events } = await makeEngine({ idleDelayMs: 5 })
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "放弃 <loop-abort>换人工处理</loop-abort>" }] },
  ]
  await store.watch("ses_abort")
  await engine.maybeInject("ses_abort")
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_abort")?.injections, 0)
  assert.equal(store.getState("ses_abort")?.state, "stopped")
  assert.ok(events.some((event) => event.state === "stopped"))
})

test("pause sentinel marks paused and does not inject", async () => {
  const { session, store, engine, events } = await makeEngine({ idleDelayMs: 5 })
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "需要确认 <loop-pause>请补充需求</loop-pause>" }] },
  ]
  await store.watch("ses_pause")
  await engine.maybeInject("ses_pause")
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_pause")?.injections, 0)
  assert.equal(store.getState("ses_pause")?.state, "paused")
  assert.ok(events.some((event) => event.state === "paused"))
})

test("paused entry: maybeInject does not inject; a real user message resumes it", async () => {
  const { session, store, engine } = await makeEngine({ idleDelayMs: 5 })
  await store.watch("ses_paused_resume")
  await store.markPaused("ses_paused_resume")
  await engine.maybeInject("ses_paused_resume")
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_paused_resume")?.state, "paused")
  // A real user message flips it back to watching and re-arms the interval.
  let scheduleCalls = 0
  const originalSchedule = engine.scheduleInterval.bind(engine)
  engine.scheduleInterval = (sessionID: string) => {
    scheduleCalls += 1
    return originalSchedule(sessionID)
  }
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_paused_resume",
    data: { item: { type: "user" } },
  })
  assert.equal(store.getState("ses_paused_resume")?.state, "watching")
  assert.equal(scheduleCalls, 1)
  engine.stopInterval("ses_paused_resume")
})

test("hydrate preserves a paused row and drops done/stopped", async () => {
  const storage = new FakeStorage() as any
  await storage.set("opencode-autocontinue.watched", {
    ses_paused: { sessionID: "ses_paused", state: "paused", injections: 1, totalInjections: 1, since: 1_000, endAt: 0 },
    ses_done2: { sessionID: "ses_done2", state: "done", injections: 1, since: 1_000, endAt: 0 },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  assert.equal(store.status("ses_paused").watched, true)
  assert.equal(store.status("ses_paused").state?.state, "paused")
  assert.equal(store.status("ses_done2").watched, false)
})

// --- ④ verify status into RPC/TUI ---

test("status()/list() expose rejections, verifying and toolFailureCount", async () => {
  const { store } = await makeEngine()
  await store.watch("ses_rpc_status")
  await store.recordRejection("ses_rpc_status")
  const status = store.status("ses_rpc_status")
  assert.equal(status.state?.rejections, 1)
  assert.equal(status.state?.verifying, false)
  assert.equal(status.state?.toolFailureCount, 0)
  const listed = store.list().find((entry) => entry.sessionID === "ses_rpc_status")
  assert.equal(listed?.rejections, 1)
  assert.equal(listed?.verifying, false)
  assert.equal(listed?.toolFailureCount, 0)
})

test("verify gate emits verifying:true while the command runs", async () => {
  let releaseRunner: () => void = () => {}
  let runnerStarted: () => void = () => {}
  const runnerGate = new Promise<void>((resolve) => {
    releaseRunner = resolve
  })
  const startedGate = new Promise<void>((resolve) => {
    runnerStarted = resolve
  })
  const { store, engine, events } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => {
      runnerStarted()
      await runnerGate
      return passVerifyResult()
    },
    { minIntervalMs: 0 },
  )
  await store.watch("ses_verifying")
  const inflight = engine.maybeInject("ses_verifying")
  await startedGate
  assert.ok(events.some((event) => event.verifying === true))
  assert.equal(store.isVerifying("ses_verifying"), true)
  releaseRunner()
  await inflight
  assert.equal(store.isVerifying("ses_verifying"), false)
  assert.equal(store.getState("ses_verifying")?.state, "done")
})

// --- ⑤ tool-failure observation counter (opt-in) ---

test("observeToolFailures defaults to false", () => {
  assert.equal(DEFAULT_CONFIG.observeToolFailures, false)
})

test("observeToolOutcome dedups failures, slices the window and clears on success", async () => {
  const { store } = await makeEngine()
  await store.watch("ses_tool_obs")
  store.observeToolOutcome("ses_tool_obs", "tool_1", true)
  store.observeToolOutcome("ses_tool_obs", "tool_1", true) // same id: not double-counted
  assert.equal(store.status("ses_tool_obs").state?.toolFailureCount, 1)
  store.observeToolOutcome("ses_tool_obs", "tool_2", true)
  assert.equal(store.status("ses_tool_obs").state?.toolFailureCount, 2)
  // A terminal success clears the count but keeps the window.
  store.observeToolOutcome("ses_tool_obs", undefined, false)
  assert.equal(store.status("ses_tool_obs").state?.toolFailureCount, 0)
  // tool_1 is still in the window: re-failing it does not re-count.
  store.observeToolOutcome("ses_tool_obs", "tool_1", true)
  assert.equal(store.status("ses_tool_obs").state?.toolFailureCount, 0)
  // An errored outcome without an id is not counted.
  store.observeToolOutcome("ses_tool_obs", undefined, true)
  assert.equal(store.status("ses_tool_obs").state?.toolFailureCount, 0)
})

test("observeToolOutcome keeps only the last 128 failed ids in the window", async () => {
  const { store } = await makeEngine()
  await store.watch("ses_tool_window")
  for (let index = 0; index < 130; index++) {
    store.observeToolOutcome("ses_tool_window", `tool_${index}`, true)
  }
  const memory = store.getMemory("ses_tool_window")
  assert.equal(memory.toolFailureIds.length, 128)
  assert.equal(memory.toolFailureIds[0], "tool_2")
  assert.equal(memory.toolFailureCount, 130)
})

test("engine observes the last tool failure only when observeToolFailures is enabled", async () => {
  const errorContext = async () => [
    {
      type: "assistant",
      content: [
        { type: "text", text: "继续推进" },
        { type: "tool", callID: "call_x", state: { status: "error" } },
      ],
    },
  ]
  const disabled = await makeEngine({ idleDelayMs: 5 })
  disabled.session.context = errorContext
  await disabled.store.watch("ses_tool_disabled")
  await disabled.engine.maybeInject("ses_tool_disabled")
  assert.equal(disabled.store.status("ses_tool_disabled").state?.toolFailureCount, 0)

  const enabled = await makeEngine({ idleDelayMs: 5, observeToolFailures: true })
  enabled.session.context = errorContext
  await enabled.store.watch("ses_tool_enabled")
  await enabled.engine.maybeInject("ses_tool_enabled")
  assert.equal(enabled.store.status("ses_tool_enabled").state?.toolFailureCount, 1)
})

// --- §8.3 full-project review fixes (v0.5.1) ---

/** Freeze the process clock at `epochMs` while `run` executes so the
 *  time-window gates can be tested deterministically. Restores the real Date
 *  afterwards; top-level node:test tests run sequentially, so the override
 *  cannot leak into a concurrent test. */
async function withFrozenClock(epochMs: number, run: () => void | Promise<void>): Promise<void> {
  const RealDate = Date
  class FrozenDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(epochMs)
      else super(...args)
    }
    static now(): number {
      return epochMs
    }
  }
  ;(globalThis as any).Date = FrozenDate
  try {
    await run()
  } finally {
    ;(globalThis as any).Date = RealDate
  }
}

/** Local epoch ms for today at HH:MM. */
function todayAt(hours: number, minutes: number): number {
  const at = new Date()
  at.setHours(hours, minutes, 0, 0)
  return at.getTime()
}

// F1: cross-midnight-aware start gate.

test("startGateClosed: non-cross-midnight window closes before startTime", async () => {
  await withFrozenClock(todayAt(7, 0), () => {
    assert.equal(startGateClosed("09:00", "17:00"), true) // before start
  })
  await withFrozenClock(todayAt(10, 0), () => {
    assert.equal(startGateClosed("09:00", "17:00"), false) // window open
  })
  await withFrozenClock(todayAt(18, 0), () => {
    assert.equal(startGateClosed("09:00", "17:00"), false) // mirrors startTimeNotReached
  })
  assert.equal(startGateClosed("", "08:30"), false) // empty start = always open
})

test("startGateClosed: cross-midnight tail is open, pre-start gap is closed", async () => {
  // 22:00 -> 08:30: at 03:00 (before startTime but before endTime) the window
  // is STILL OPEN; at 09:00 (before startTime but past endTime) it is closed.
  await withFrozenClock(todayAt(3, 0), () => {
    assert.equal(startGateClosed("22:00", "08:30"), false)
  })
  await withFrozenClock(todayAt(9, 0), () => {
    assert.equal(startGateClosed("22:00", "08:30"), true)
  })
  await withFrozenClock(todayAt(23, 0), () => {
    assert.equal(startGateClosed("22:00", "08:30"), false)
  })
})

test("F1: a cross-midnight window still injects at a post-midnight clock", async () => {
  await withFrozenClock(todayAt(3, 0), async () => {
    const { session, store, engine } = await makeEngine({
      intervalMs: 60_000,
      idleDelayMs: 5,
      startTime: "22:00",
      endTime: "08:30",
    })
    await store.watch("ses_cross_midnight")
    await engine.maybeInject("ses_cross_midnight")
    assert.equal(session.prompts.length, 1)
    assert.equal(store.getState("ses_cross_midnight")?.state, "watching")
  })
})

// F2: verify-gate pre-command TOCTOU.

test("F2: a real user message during the pre-command awaits suppresses verification", async () => {
  let releaseContext: () => void = () => {}
  let contextStarted: () => void = () => {}
  const contextGate = new Promise<void>((resolve) => {
    releaseContext = resolve
  })
  const startedGate = new Promise<void>((resolve) => {
    contextStarted = resolve
  })
  let firstCall = true
  let verifyCalls = 0
  const messages = [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] },
  ]
  const { session, store, engine } = await makeVerifyEngine(
    async () => {
      if (firstCall) {
        firstCall = false
        contextStarted()
        await contextGate
      }
      return messages as any
    },
    async () => {
      verifyCalls += 1
      return passVerifyResult()
    },
    { minIntervalMs: 0, userGraceMs: 60_000 },
  )
  await store.watch("ses_f2_pre")
  const inflight = engine.maybeInject("ses_f2_pre")
  await startedGate
  // A real user message lands while maybeInject is still awaiting the context,
  // i.e. BEFORE runVerifyGate captures its round snapshot.
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_f2_pre",
    data: { item: { type: "user" } },
  })
  releaseContext()
  await inflight
  assert.equal(verifyCalls, 0)
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_f2_pre")?.state, "watching")
})

test("F2: a real user message during the command discards the result", async () => {
  let releaseRunner: () => void = () => {}
  let runnerStarted: () => void = () => {}
  const runnerGate = new Promise<void>((resolve) => {
    releaseRunner = resolve
  })
  const startedGate = new Promise<void>((resolve) => {
    runnerStarted = resolve
  })
  const { session, store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => {
      runnerStarted()
      await runnerGate
      return passVerifyResult()
    },
    { minIntervalMs: 0, userGraceMs: 0 },
  )
  await store.watch("ses_f2_flight")
  const inflight = engine.maybeInject("ses_f2_flight")
  await startedGate
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_f2_flight",
    data: { item: { type: "user" } },
  })
  releaseRunner()
  await inflight
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_f2_flight")?.state, "watching")
  assert.equal(store.getState("ses_f2_flight")?.rejections, 0)
})

// F6: state.changed carries toolFailureCount.

test("F6: a state.changed event carries toolFailureCount", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    {
      type: "assistant",
      content: [
        { type: "text", text: "已完成第一阶段的代码审查，共发现 3 个问题。" },
        { type: "tool", callID: "call_f6", state: { status: "error" } },
      ],
    },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: Array<{ toolFailureCount?: number }> = []
  const engine = new AutocontinueEngine(
    session as any,
    () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5, observeToolFailures: true }),
    store,
    (event) => {
      events.push({ toolFailureCount: (event as { toolFailureCount?: number }).toolFailureCount })
    },
  )
  await store.watch("ses_f6")
  await engine.maybeInject("ses_f6")
  assert.equal(store.getMemory("ses_f6").toolFailureCount, 1)
  assert.ok(events.some((event) => event.toolFailureCount === 1))
})

// F7: V1 tool_result parts are scanned across ALL messages.

test("F7: a V1 tool_use + separate tool_result(is_error) counts one failure", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "已完成第一阶段的代码审查，共发现 3 个问题。" },
        { type: "tool_use", id: "v1_call", tool: "bash" },
      ],
    },
    {
      info: { role: "user" },
      parts: [{ type: "tool_result", tool_use_id: "v1_call", is_error: true, content: "boom" }],
    },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(
    session as any,
    () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5, observeToolFailures: true }),
    store,
    () => {},
  )
  await store.watch("ses_f7")
  await engine.maybeInject("ses_f7")
  assert.equal(store.getMemory("ses_f7").toolFailureCount, 1)
})

// F8: abort sentinel beats the background-work guard.

test("F8: an abort sentinel stops even while a background subagent is running", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "放弃 <loop-abort>换人工处理</loop-abort>" }] },
    { type: "synthetic", metadata: { source: "subagent", childID: "ses_child", agent: "fixer" } },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(
    session as any,
    () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }),
    store,
    (event) => {
      events.push(event.state)
    },
  )
  await store.watch("ses_f8")
  await engine.maybeInject("ses_f8")
  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_f8")?.state, "stopped")
  assert.ok(events.includes("stopped"))
})

// Sentinel precedence.

test("abort wins over pause when both sentinels appear", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "中止吧 <loop-abort>停止</loop-abort> 或者稍等 <loop-pause>等待</loop-pause>" },
      ],
    },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_prec_abort")
  await engine.maybeInject("ses_prec_abort")
  assert.equal(store.getState("ses_prec_abort")?.state, "stopped")
  assert.equal(session.prompts.length, 0)
})

test("a sentinel beats a completion marker in the same message", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成] <loop-abort>还是停吧</loop-abort>" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const events: string[] = []
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, (event) => {
    events.push(event.state)
  })
  await store.watch("ses_prec_marker")
  await engine.maybeInject("ses_prec_marker")
  assert.equal(store.getState("ses_prec_marker")?.state, "stopped")
  assert.equal(session.prompts.length, 0)
  assert.ok(!events.includes("confirming"))
  assert.ok(!events.includes("done"))
})

test("under verifyCommand a sentinel still stops/pauses without running verify", async () => {
  let verifyCalls = 0
  const abortRun = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成] <loop-abort>停</loop-abort>" }] }],
    async () => {
      verifyCalls += 1
      return passVerifyResult()
    },
    { minIntervalMs: 0 },
  )
  await abortRun.store.watch("ses_sent_verify_abort")
  await abortRun.engine.maybeInject("ses_sent_verify_abort")
  assert.equal(verifyCalls, 0)
  assert.equal(abortRun.store.getState("ses_sent_verify_abort")?.state, "stopped")
  assert.equal(abortRun.session.prompts.length, 0)

  const pauseRun = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成] <loop-pause>等补充</loop-pause>" }] }],
    async () => {
      verifyCalls += 1
      return passVerifyResult()
    },
    { minIntervalMs: 0 },
  )
  await pauseRun.store.watch("ses_sent_verify_pause")
  await pauseRun.engine.maybeInject("ses_sent_verify_pause")
  assert.equal(verifyCalls, 0)
  assert.equal(pauseRun.store.getState("ses_sent_verify_pause")?.state, "paused")
  assert.equal(pauseRun.session.prompts.length, 0)
})

// Verify-gate terminal outcomes through the GATE (not only runVerification).

test("verify gate: a timedOut result counts a rejection and re-injects", async () => {
  const { session, store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => ({
      pass: false,
      timedOut: true,
      spawnUnavailable: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      detail: "",
    }),
    { minIntervalMs: 0 },
  )
  await store.watch("ses_gate_timeout")
  await engine.maybeInject("ses_gate_timeout")
  assert.equal(store.getState("ses_gate_timeout")?.state, "watching")
  assert.equal(store.getState("ses_gate_timeout")?.rejections, 1)
  assert.equal(session.prompts.length, 1)
  assert.match(session.prompts[0] ?? "", /验证未通过/)
})

test("verify gate: a spawnUnavailable (pass:true) result marks done without looping", async () => {
  const { session, store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => ({
      pass: true,
      timedOut: false,
      spawnUnavailable: true,
      exitCode: null,
      stdout: "",
      stderr: "",
      detail: "",
    }),
    { minIntervalMs: 0 },
  )
  await store.watch("ses_gate_unavail")
  await engine.maybeInject("ses_gate_unavail")
  assert.equal(store.getState("ses_gate_unavail")?.state, "done")
  assert.equal(session.prompts.length, 0)
})

// Lifecycle smoke.

test("resumeKeepAlives schedules intervals only for active watches (lifecycle)", async () => {
  const { store, engine } = await makeEngine({ intervalMs: 60_000 })
  await store.watch("ses_ka_watch")
  await store.watch("ses_ka_paused")
  await store.markPaused("ses_ka_paused")
  const scheduled: string[] = []
  const originalSchedule = engine.scheduleInterval.bind(engine)
  engine.scheduleInterval = (sessionID: string) => {
    scheduled.push(sessionID)
    return originalSchedule(sessionID)
  }
  engine.resumeKeepAlives()
  assert.ok(scheduled.includes("ses_ka_watch"))
  assert.ok(!scheduled.includes("ses_ka_paused"))
  engine.stopInterval("ses_ka_watch")
})

test("abortVerify aborts an in-flight verification command (lifecycle)", async () => {
  let observedSignal: AbortSignal | undefined
  let runnerStarted: () => void = () => {}
  const startedGate = new Promise<void>((resolve) => {
    runnerStarted = resolve
  })
  const { store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async (spec) => {
      observedSignal = spec.signal
      runnerStarted()
      await new Promise<void>((resolve) => {
        if (spec.signal?.aborted) return resolve()
        spec.signal?.addEventListener("abort", () => resolve())
      })
      return passVerifyResult()
    },
    { minIntervalMs: 0 },
  )
  await store.watch("ses_abortverify")
  const inflight = engine.maybeInject("ses_abortverify")
  await startedGate
  engine.abortVerify("ses_abortverify")
  await store.unwatch("ses_abortverify")
  await inflight
  assert.equal(observedSignal?.aborted, true)
  assert.equal(store.getState("ses_abortverify"), undefined)
})

test("WatchStore.resetInjectionCount dead code is removed", async () => {
  const { store } = await makeEngine()
  assert.equal((store as { resetInjectionCount?: unknown }).resetInjectionCount, undefined)
})

// --- P2: frustration trigger (a complaint decorates the next injection) ---

test("matchesFrustration is a case-insensitive substring match on a non-empty trigger list", () => {
  assert.equal(matchesFrustration("这个结果太糟糕了", ["糟糕"]), true)
  assert.equal(matchesFrustration("这个结果太糟糕了", ["糟 糕"]), false)
  assert.equal(matchesFrustration("这个结果太糟糕了", ["糟糕".toUpperCase()]), true)
  // An empty trigger list disables the feature (the default).
  assert.equal(matchesFrustration("这个结果太糟糕了", []), false)
  // No text -> no match.
  assert.equal(matchesFrustration(undefined, ["糟糕"]), false)
})

test("a frustrated user turn appends the frustration clause to the next injection", async () => {
  const { session, store, engine } = await makeEngine({
    frustrationTriggers: ["不满意"],
    userGraceMs: 0,
    minIntervalMs: 0,
  })
  await store.watch("ses_frustrated")
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_frustrated",
    data: { item: { type: "user", payload: { text: "这个结果太让人不满意了" } } },
  })
  await engine.maybeInject("ses_frustrated")
  assert.equal(session.prompts.length, 1)
  assert.ok(session.prompts[0]?.includes(DEFAULT_CONFIG.frustrationMessage))
  // The clause is one-shot: the injection after it is plain again.
  await engine.maybeInject("ses_frustrated")
  assert.equal(session.prompts.length, 2)
  assert.ok(!session.prompts[1]?.includes(DEFAULT_CONFIG.frustrationMessage))
})

test("an ordinary user turn does not append the frustration clause", async () => {
  const { session, store, engine } = await makeEngine({
    frustrationTriggers: ["不满意"],
    userGraceMs: 0,
    minIntervalMs: 0,
  })
  await store.watch("ses_calm")
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_calm",
    data: { item: { type: "user", payload: { text: "继续推进下一步" } } },
  })
  await engine.maybeInject("ses_calm")
  assert.equal(session.prompts.length, 1)
  assert.ok(!session.prompts[0]?.includes(DEFAULT_CONFIG.frustrationMessage))
})

test("the V1 message.updated shape also detects a frustrated user turn", async () => {
  const { session, store, engine } = await makeEngine({
    frustrationTriggers: ["不满意"],
    userGraceMs: 0,
    minIntervalMs: 0,
  })
  await store.watch("ses_frustrated_v1")
  await engine.handleEvent({
    type: "message.updated",
    sessionID: "ses_frustrated_v1",
    properties: {
      info: { role: "user", parts: [{ type: "text", text: "这做的太不满意了" }] },
    },
  })
  await engine.maybeInject("ses_frustrated_v1")
  assert.equal(session.prompts.length, 1)
  assert.ok(session.prompts[0]?.includes(DEFAULT_CONFIG.frustrationMessage))
})

test("our own injected text returning as a user turn never triggers frustration", async () => {
  // The trigger ("继续执行") is part of our own continuation message, so only
  // the self-echo guard can keep the frustration clause out of the next
  // injection.
  const { session, store, engine } = await makeEngine({
    frustrationTriggers: ["继续执行"],
    userGraceMs: 0,
    minIntervalMs: 0,
  })
  await store.watch("ses_frustrated_echo")
  await engine.maybeInject("ses_frustrated_echo")
  assert.equal(session.prompts.length, 1)
  const injectedText = session.prompts[0] ?? ""
  // Feed our own text back as a plain user message (no provenance metadata).
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_frustrated_echo",
    data: { item: { type: "user", payload: { text: injectedText } } },
  })
  assert.equal(store.getMemory("ses_frustrated_echo").frustrationPending, false)
  await engine.maybeInject("ses_frustrated_echo")
  assert.equal(session.prompts.length, 2)
  assert.ok(!session.prompts[1]?.includes(DEFAULT_CONFIG.frustrationMessage))
})

test("a frustrated turn keeps the rejection counter while an ordinary turn resets it", async () => {
  const { store, engine } = await makeEngine({
    frustrationTriggers: ["不满意"],
    userGraceMs: 0,
  })
  await store.watch("ses_rejections")
  await store.recordRejection("ses_rejections")
  assert.equal(store.getState("ses_rejections")?.rejections, 1)
  // A complaint IS evidence that the last delivery was rejected: keep it.
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_rejections",
    data: { item: { type: "user", payload: { text: "太不满意了" } } },
  })
  assert.equal(store.getState("ses_rejections")?.rejections, 1)
  // An ordinary new turn starts a clean round.
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_rejections",
    data: { item: { type: "user", payload: { text: "换个方向继续" } } },
  })
  assert.equal(store.getState("ses_rejections")?.rejections, 0)
})

// --- P3: observable stop reasons ---

test("the verify cap stops the round with stopReason verify-limit", async () => {
  const { store, engine } = await makeVerifyEngine(
    async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }],
    async () => failVerifyResult(1),
    { minIntervalMs: 0, verifyMaxIterations: 2 },
  )
  await store.watch("ses_reason_verify")
  await engine.maybeInject("ses_reason_verify")
  await engine.maybeInject("ses_reason_verify")
  assert.equal(store.getState("ses_reason_verify")?.state, "stopped")
  assert.equal(store.getState("ses_reason_verify")?.stopReason, "verify-limit")
  assert.equal(store.status("ses_reason_verify").state?.stopReason, "verify-limit")
  assert.equal(store.list().find((row) => row.sessionID === "ses_reason_verify")?.stopReason, "verify-limit")
})

test("the watch budget stopping the round reports stopReason watch-timeout", async () => {
  const { store, engine, events } = await makeEngine({ watchTimeoutMs: 5_000 })
  await store.watch("ses_reason_timeout")
  const entry = store.getState("ses_reason_timeout")
  if (entry) entry.since = Date.now() - 10_000
  await engine.maybeInject("ses_reason_timeout")
  assert.equal(store.getState("ses_reason_timeout")?.state, "stopped")
  assert.equal(store.getState("ses_reason_timeout")?.stopReason, "watch-timeout")
  assert.equal(store.status("ses_reason_timeout").state?.stopReason, "watch-timeout")
  const stoppedEvent = events.find((event) => event.state === "stopped")
  assert.equal(stoppedEvent?.stopReason, "watch-timeout")
})

test("the injection cap stopping the round reports stopReason injection-cap", async () => {
  const { store, engine, events } = await makeEngine({ maxConsecutive: 1, minIntervalMs: 0 })
  await store.watch("ses_reason_cap")
  await engine.maybeInject("ses_reason_cap")
  await engine.maybeInject("ses_reason_cap")
  assert.equal(store.getState("ses_reason_cap")?.state, "stopped")
  assert.equal(store.getState("ses_reason_cap")?.stopReason, "injection-cap")
  const stoppedEvent = events.find((event) => event.state === "stopped")
  assert.equal(stoppedEvent?.stopReason, "injection-cap")
})

test("the closed time window reports stopReason window-closed", async () => {
  const { store, engine } = await makeEngine()
  await store.watch("ses_reason_window", Date.now() - 1_000)
  await engine.maybeInject("ses_reason_window")
  assert.equal(store.getState("ses_reason_window")?.state, "stopped")
  assert.equal(store.getState("ses_reason_window")?.stopReason, "window-closed")
})

test("an abort sentinel reports stopReason abort-sentinel", async () => {
  const session = makeFakeSession()
  session.context = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "放弃 <loop-abort>换人工处理</loop-abort>" }] },
  ]
  const store = new WatchStore(new FakeStorage() as any)
  await store.hydrate()
  const engine = new AutocontinueEngine(session as any, () => ({ ...DEFAULT_CONFIG, idleDelayMs: 5 }), store, () => {})
  await store.watch("ses_reason_abort")
  await engine.maybeInject("ses_reason_abort")
  assert.equal(store.getState("ses_reason_abort")?.stopReason, "abort-sentinel")
})

test("an interrupted run reports stopReason idle-interrupted / user-interrupted", async () => {
  const v1 = await makeEngine({ idleDelayMs: 5 })
  await v1.store.watch("ses_reason_idle")
  await v1.engine.handleEvent({ type: "session.idle", sessionID: "ses_reason_idle", outcome: "interrupted" })
  assert.equal(v1.store.getState("ses_reason_idle")?.stopReason, "idle-interrupted")

  const v2 = await makeEngine({ idleDelayMs: 5 })
  await v2.store.watch("ses_reason_interrupted")
  await v2.engine.handleEvent({ type: "session.execution.interrupted", sessionID: "ses_reason_interrupted" })
  assert.equal(v2.store.getState("ses_reason_interrupted")?.stopReason, "user-interrupted")
})

test("markStopped without a reason clears a previously stored stop reason", async () => {
  const { store } = await makeEngine()
  await store.watch("ses_reason_cleared")
  await store.markStopped("ses_reason_cleared", "verify-limit")
  assert.equal(store.getState("ses_reason_cleared")?.stopReason, "verify-limit")
  await store.markStopped("ses_reason_cleared")
  assert.equal(store.getState("ses_reason_cleared")?.stopReason, undefined)
  assert.equal(store.status("ses_reason_cleared").state?.stopReason, undefined)
})

test("hydrate keeps a valid stop reason and drops an invalid one", async () => {
  const storage = new FakeStorage() as any
  await storage.set("opencode-autocontinue.watched", {
    ses_reason_valid: {
      sessionID: "ses_reason_valid",
      state: "watching",
      injections: 0,
      since: 1_000,
      endAt: 0,
      stopReason: "watch-timeout",
    },
    ses_reason_invalid: {
      sessionID: "ses_reason_invalid",
      state: "watching",
      injections: 0,
      since: 1_000,
      endAt: 0,
      stopReason: "not-a-reason",
    },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  assert.equal(store.getState("ses_reason_valid")?.stopReason, "watch-timeout")
  assert.equal(store.getState("ses_reason_invalid")?.stopReason, undefined)
})