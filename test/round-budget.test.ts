// Coverage for the per-round wall-clock budget (v0.5.3).
//
// The watch budget used to be measured from `since` — the moment the whole
// watch started. Every real user message therefore inherited the remainder of
// a budget that was already almost gone, and a long-running watch could be
// stopped by a timeout it had already "paid for". The budget is now measured
// per round: `roundSince` marks the start of the current round, `resume()`
// (a real user message) refreshes it, and `since` keeps marking the start of
// the watch for the sidebar timer.
//
// Run: node --experimental-strip-types --test test/round-budget.test.ts

import { afterEach, test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { WatchStore } from "../src/state.ts"
import { createEngine, disposeEngines, FakeStorage, makeFakeSession, withFakeClock } from "./support/harness.ts"

const STORAGE_KEY = "opencode-autocontinue.watched"
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

afterEach(() => {
  disposeEngines()
})

test("watch() starts the round budget and the watch timer at the same moment", async () => {
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const entry = await store.watch("ses_round_start")
  assert.equal(entry.since, entry.roundSince)
})

test("resume() refreshes the round budget but keeps the watch start time", async () => {
  await withFakeClock(1_700_000_000_000, async (clock) => {
    const store = new WatchStore(new FakeStorage())
    await store.hydrate()
    await store.watch("ses_round_resume")
    const beforeResume = store.getState("ses_round_resume")
    assert.ok(beforeResume)
    const watchStart = beforeResume.since
    const firstRoundStart = beforeResume.roundSince

    clock.advance(HOUR_MS)
    await store.resume("ses_round_resume")
    const afterResume = store.getState("ses_round_resume")
    assert.ok(afterResume)
    assert.equal(afterResume.since, watchStart, "since must keep marking the start of the watch")
    assert.equal(afterResume.roundSince, firstRoundStart + HOUR_MS, "resume must start a fresh round budget")
  })
})

test("a real user message refreshes the round budget and keeps the watch start time", async () => {
  await withFakeClock(1_700_000_000_000, async (clock) => {
    const session = makeFakeSession()
    const store = new WatchStore(new FakeStorage())
    await store.hydrate()
    const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG, userGraceMs: 0 }), store, () => {})
    await store.watch("ses_round_user_message")
    const watchStart = store.getState("ses_round_user_message")?.since
    assert.equal(watchStart, 1_700_000_000_000)

    clock.advance(5 * HOUR_MS)
    await engine.handleEvent({
      type: "session.inbox.enqueued",
      sessionID: "ses_round_user_message",
      data: { item: { type: "user" } },
    })

    const entry = store.getState("ses_round_user_message")
    assert.equal(entry?.since, watchStart, "the watch start time must not move")
    assert.equal(entry?.roundSince, 1_700_000_000_000 + 5 * HOUR_MS, "the round budget must restart now")
  })
})

test("a new round gets a fresh wall-clock budget instead of the exhausted one", async () => {
  await withFakeClock(1_700_000_000_000, async (clock) => {
    const session = makeFakeSession()
    const store = new WatchStore(new FakeStorage())
    await store.hydrate()
    const engine = createEngine(
      session,
      () => ({ ...DEFAULT_CONFIG, userGraceMs: 0, minIntervalMs: 0 }),
      store,
      () => {},
    )
    await store.watch("ses_round_fresh_budget")

    // The round budget (24h by default) is exhausted.
    clock.advance(25 * HOUR_MS)
    // A real user message opens a new round with a new budget.
    await engine.handleEvent({
      type: "session.inbox.enqueued",
      sessionID: "ses_round_fresh_budget",
      data: { item: { type: "user" } },
    })
    await engine.maybeInject("ses_round_fresh_budget")

    assert.equal(store.getState("ses_round_fresh_budget")?.state, "watching")
    assert.equal(store.getState("ses_round_fresh_budget")?.stopReason, undefined)
    assert.equal(session.prompts.length, 1, "the new round must be allowed to inject")
  })
})

test("an exhausted round budget stops the round through the engine", async () => {
  await withFakeClock(1_700_000_000_000, async (clock) => {
    const session = makeFakeSession()
    const store = new WatchStore(new FakeStorage())
    await store.hydrate()
    const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG }), store, () => {})
    await store.watch("ses_round_exhausted")

    clock.advance(25 * HOUR_MS)
    await engine.maybeInject("ses_round_exhausted")

    assert.equal(session.prompts.length, 0)
    assert.equal(store.getState("ses_round_exhausted")?.state, "stopped")
    assert.equal(store.getState("ses_round_exhausted")?.stopReason, "watch-timeout")
  })
})

test("the shipped 24h watch budget stops a round that outlives it", async () => {
  await withFakeClock(1_700_000_000_000, async (clock) => {
    const session = makeFakeSession()
    const store = new WatchStore(new FakeStorage())
    await store.hydrate()
    const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG }), store, () => {})
    await store.watch("ses_round_default_budget")

    // Just under the budget: still watching.
    clock.advance(DEFAULT_CONFIG.watchTimeoutMs - 1)
    await engine.maybeInject("ses_round_default_budget")
    assert.equal(store.getState("ses_round_default_budget")?.state, "watching")
    assert.equal(session.prompts.length, 1)

    // One millisecond later the budget is gone.
    clock.advance(1)
    await engine.maybeInject("ses_round_default_budget")
    assert.equal(store.getState("ses_round_default_budget")?.state, "stopped")
    assert.equal(store.getState("ses_round_default_budget")?.stopReason, "watch-timeout")
    assert.equal(session.prompts.length, 1)
  })
})

test("hydrate falls back to the watch start time when the persisted row has no roundSince", async () => {
  const storage = new FakeStorage()
  await storage.set(STORAGE_KEY, {
    ses_legacy_round: {
      sessionID: "ses_legacy_round",
      state: "watching",
      injections: 0,
      totalInjections: 0,
      since: 1_600_000_000_000,
      endAt: 0,
    },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  const entry = store.getState("ses_legacy_round")
  assert.equal(entry?.since, 1_600_000_000_000)
  assert.equal(
    entry?.roundSince,
    1_600_000_000_000,
    "a legacy row without roundSince must inherit the row's since",
  )
})

test("hydrate keeps the persisted roundSince when the row carries one", async () => {
  const storage = new FakeStorage()
  await storage.set(STORAGE_KEY, {
    ses_round_persisted: {
      sessionID: "ses_round_persisted",
      state: "watching",
      injections: 0,
      totalInjections: 0,
      since: 1_600_000_000_000,
      roundSince: 1_650_000_000_000,
      endAt: 0,
    },
  })
  const store = new WatchStore(storage)
  await store.hydrate()
  const entry = store.getState("ses_round_persisted")
  assert.equal(entry?.since, 1_600_000_000_000)
  assert.equal(entry?.roundSince, 1_650_000_000_000)
})

test("watchTimeoutMs 0 keeps the round alive no matter how long it runs", async () => {
  await withFakeClock(1_700_000_000_000, async (clock) => {
    const session = makeFakeSession()
    const store = new WatchStore(new FakeStorage())
    await store.hydrate()
    const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG, watchTimeoutMs: 0 }), store, () => {})
    await store.watch("ses_round_no_budget")

    clock.advance(100 * DAY_MS)
    await engine.maybeInject("ses_round_no_budget")

    assert.equal(store.getState("ses_round_no_budget")?.state, "watching")
    assert.equal(store.getState("ses_round_no_budget")?.stopReason, undefined)
    assert.equal(session.prompts.length, 1, "an unlimited budget must still allow the injection")
  })
})

test("verifyMaxIterations 0 keeps a failing verification round alive", async () => {
  const session = makeFakeSession({
    messages: async () => [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] },
    ],
  })
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session,
    () => ({ ...DEFAULT_CONFIG, verifyCommand: "node --version", verifyMaxIterations: 0, minIntervalMs: 0 }),
    store,
    () => {},
    async () => ({
      pass: false,
      timedOut: false,
      spawnUnavailable: false,
      exitCode: 1,
      stdout: "boom",
      stderr: "",
      detail: "",
    }),
  )
  await store.watch("ses_verify_unlimited")
  await engine.maybeInject("ses_verify_unlimited")

  assert.equal(store.getState("ses_verify_unlimited")?.state, "watching")
  assert.equal(store.getState("ses_verify_unlimited")?.stopReason, undefined)
  assert.notEqual(store.getState("ses_verify_unlimited")?.stopReason, "verify-limit")
  assert.equal(store.getState("ses_verify_unlimited")?.rejections, 1)
  assert.equal(session.prompts.length, 1, "the failed round must inject the escalation prompt")
})
