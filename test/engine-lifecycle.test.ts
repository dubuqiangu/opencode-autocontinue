// Coverage for the guardrails and the lifecycle behaviour of src/engine.ts
// and src/state.ts.
//
// The behaviours under test:
//
//  - B1 self-echo guard: the record of our own injection stays usable for the
//    WHOLE self-echo window, so a host that delivers the same injection twice
//    (session.inbox.enqueued + message.updated) never resets the round.
//  - B2 globally monotonic round ids: watch() / resume() never hand out 0 and
//    never reuse an id, so a stale verification result can never decide the
//    round that replaced it.
//  - B3 lock vs. round cache: the in-flight lock survives a new round, the
//    per-round cache does not.
//  - B4 disposed guard: a disposed engine neither reacts to events nor keeps
//    a timer alive.
//  - B5 final-check race: the watch state is re-checked after
//    beginConfirming(), so a session that was switched off meanwhile is never
//    injected into.
//  - B6 timer clamping: an over-long delay never degenerates into a 1ms hot
//    loop.
//  - B7 config reads: an event for an unwatched session costs no config read
//    at all, and the echo check does not read the config a second time.
//  - B8 / B9 naming and event shape: src/engine.ts uses `pluginConfig` (never
//    a bare `cfg`) and its EventLike interface carries the optional status
//    and error fields.
//
// Run: node --experimental-strip-types --test test/engine-lifecycle.test.ts

import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { WatchStore } from "../src/state.ts"
import { clampTimerDelay, MAX_TIMER_DELAY_MS } from "../src/engine.ts"
import { isPluginInjection, PROVENANCE_METADATA } from "../src/prompt.ts"
import {
  assertNoLiveEngines,
  createEngine,
  disposeEngines,
  FakeStorage,
  makeFakeSession,
  withFakeClock,
} from "./support/harness.ts"

/** The storage key the watch store persists under. */
const STORAGE_KEY = "opencode-autocontinue.watched"

/** A fixed epoch so every clock-dependent assertion is deterministic. */
const FROZEN_EPOCH_MS = 1_700_000_000_000

afterEach(() => {
  disposeEngines()
})

/** Sleep for real time (the fake clock only moves Date, not the timers). */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** A pass / fail verdict of the fake verification command. */
function verifyVerdict(pass: boolean) {
  return {
    pass,
    timedOut: false,
    spawnUnavailable: false,
    exitCode: pass ? 0 : 1,
    stdout: "",
    stderr: "",
    detail: "",
  }
}

/**
 * An engine with a deterministic configuration: no periodic interval, no
 * min-interval gate, no user grace period and a 5ms idle delay.
 */
async function makeLifecycleEngine(
  overrides: Partial<typeof DEFAULT_CONFIG> = {},
  verifyRunner?: (spec: any) => Promise<any>,
) {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const config = () => ({
    ...DEFAULT_CONFIG,
    idleDelayMs: 5,
    intervalMs: 0,
    minIntervalMs: 0,
    userGraceMs: 0,
    ...overrides,
  })
  const engine = createEngine(session as any, config, store, () => {}, verifyRunner)
  return { session, store, engine, config }
}

/** An assistant turn that carries no completion marker (an ordinary round). */
async function ordinaryAssistantTurn(): Promise<readonly unknown[]> {
  return [{ info: { role: "assistant" }, parts: [{ type: "text", text: "还在推进" }] }]
}

/** An assistant turn that carries the default completion marker. */
async function completedAssistantTurn(): Promise<readonly unknown[]> {
  return [{ info: { role: "assistant" }, parts: [{ type: "text", text: "完成 [任务完成]" }] }]
}

// --- B1: the self-echo guard ---

test("B1: the same injection delivered twice stays an echo on both deliveries", async () => {
  await withFakeClock(FROZEN_EPOCH_MS, async () => {
    const { session, store, engine } = await makeLifecycleEngine()
    session.context = ordinaryAssistantTurn
    await store.watch("ses_b1_twice")

    await engine.maybeInject("ses_b1_twice")
    assert.equal(session.prompts.length, 1, "the round must inject once")
    const injectedText = session.prompts[0] ?? ""
    const roundIdBefore = store.getState("ses_b1_twice")?.roundId

    // First delivery: the V2 inbox shape.
    await engine.handleEvent({
      type: "session.inbox.enqueued",
      sessionID: "ses_b1_twice",
      data: { item: { type: "user", payload: { text: injectedText } } },
    })
    // Second delivery: the V1 message.updated shape, same text.
    await engine.handleEvent({
      type: "message.updated",
      sessionID: "ses_b1_twice",
      properties: { info: { role: "user", parts: [{ type: "text", text: injectedText }] } },
    })

    assert.equal(
      store.getMemory("ses_b1_twice").lastUserMessageAt,
      0,
      "neither delivery may look like a real user turn",
    )
    assert.equal(
      store.getState("ses_b1_twice")?.injections,
      1,
      "an echo must not reset the injection counter",
    )
    assert.equal(
      store.getState("ses_b1_twice")?.roundId,
      roundIdBefore,
      "an echo must not advance the round id",
    )
  })
})

test("B1: an inbound item without extractable text inside the window is an echo", async () => {
  await withFakeClock(FROZEN_EPOCH_MS, async () => {
    const { session, store, engine } = await makeLifecycleEngine()
    session.context = ordinaryAssistantTurn
    await store.watch("ses_b1_no_text")

    await engine.maybeInject("ses_b1_no_text")
    assert.equal(session.prompts.length, 1)

    // The host delivered the injection in a shape that carries no text.
    await engine.handleEvent({
      type: "session.inbox.enqueued",
      sessionID: "ses_b1_no_text",
      data: { item: { type: "user" } },
    })

    assert.equal(store.getMemory("ses_b1_no_text").lastUserMessageAt, 0)
    assert.equal(store.getState("ses_b1_no_text")?.injections, 1)
  })
})

test("B1: an inbound item with a different text is a real user turn", async () => {
  await withFakeClock(FROZEN_EPOCH_MS, async () => {
    const { session, store, engine } = await makeLifecycleEngine()
    session.context = ordinaryAssistantTurn
    await store.watch("ses_b1_different")

    await engine.maybeInject("ses_b1_different")
    const roundIdBefore = store.getState("ses_b1_different")?.roundId ?? 0

    await engine.handleEvent({
      type: "session.inbox.enqueued",
      sessionID: "ses_b1_different",
      data: { item: { type: "user", payload: { text: "换个方向继续" } } },
    })

    assert.ok(
      store.getMemory("ses_b1_different").lastUserMessageAt > 0,
      "a different text is a real user turn",
    )
    assert.equal(store.getState("ses_b1_different")?.injections, 0, "a real turn starts a fresh round")
    assert.ok(
      (store.getState("ses_b1_different")?.roundId ?? 0) > roundIdBefore,
      "a real turn advances the round id",
    )
  })
})

test("B1: the same text outside the self-echo window is a real user turn", async () => {
  await withFakeClock(FROZEN_EPOCH_MS, async (clock) => {
    const { session, store, engine } = await makeLifecycleEngine()
    session.context = ordinaryAssistantTurn
    await store.watch("ses_b1_expired")

    await engine.maybeInject("ses_b1_expired")
    const injectedText = session.prompts[0] ?? ""

    clock.advance(DEFAULT_CONFIG.selfEchoWindowMs + 1)
    await engine.handleEvent({
      type: "session.inbox.enqueued",
      sessionID: "ses_b1_expired",
      data: { item: { type: "user", payload: { text: injectedText } } },
    })

    assert.ok(store.getMemory("ses_b1_expired").lastUserMessageAt > 0)
    assert.equal(store.getState("ses_b1_expired")?.injections, 0)
  })
})

test("B1: with a zero self-echo window the same text is a real user turn", async () => {
  await withFakeClock(FROZEN_EPOCH_MS, async (clock) => {
    const { session, store, engine } = await makeLifecycleEngine({ selfEchoWindowMs: 0 })
    session.context = ordinaryAssistantTurn
    await store.watch("ses_b1_zero_window")

    await engine.maybeInject("ses_b1_zero_window")
    const injectedText = session.prompts[0] ?? ""

    clock.advance(1)
    await engine.handleEvent({
      type: "session.inbox.enqueued",
      sessionID: "ses_b1_zero_window",
      data: { item: { type: "user", payload: { text: injectedText } } },
    })

    assert.ok(store.getMemory("ses_b1_zero_window").lastUserMessageAt > 0)
    assert.equal(store.getState("ses_b1_zero_window")?.injections, 0)
  })
})

test("B1: provenance metadata makes an inbound item an echo, whatever its text", async () => {
  await withFakeClock(FROZEN_EPOCH_MS, async (clock) => {
    assert.equal(isPluginInjection(PROVENANCE_METADATA), true, "the fixture must be a plugin injection")
    const { session, store, engine } = await makeLifecycleEngine()
    session.context = ordinaryAssistantTurn
    await store.watch("ses_b1_provenance")

    await engine.maybeInject("ses_b1_provenance")

    // Even outside the window and with a completely different text the
    // provenance stamp is authoritative.
    clock.advance(DEFAULT_CONFIG.selfEchoWindowMs + 1)
    await engine.handleEvent({
      type: "session.inbox.enqueued",
      sessionID: "ses_b1_provenance",
      data: {
        item: {
          type: "user",
          payload: { text: "完全不同的文本", metadata: PROVENANCE_METADATA },
        },
      },
    })

    assert.equal(store.getMemory("ses_b1_provenance").lastUserMessageAt, 0)
    assert.equal(store.getState("ses_b1_provenance")?.injections, 1)
  })
})

// --- B2: globally monotonic round ids ---

test("B2: watch() hands out a round id that is never 0", async () => {
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const entry = await store.watch("ses_b2_first")
  assert.ok(entry.roundId > 0, "a watch round must carry a real round id")
})

test("B2: round ids are strictly increasing across sessions", async () => {
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const first = await store.watch("ses_b2_a")
  const second = await store.watch("ses_b2_b")
  assert.ok(second.roundId > first.roundId, "each watch takes the next id")
})

test("B2: resume() takes an id greater than every id handed out so far", async () => {
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const first = await store.watch("ses_b2_resume")
  const other = await store.watch("ses_b2_other")
  // watch() hands out the LIVE entry object: resume() mutates it, so the
  // issued ids have to be snapshotted before the resume.
  const firstRoundId = first.roundId
  const otherRoundId = other.roundId
  await store.resume("ses_b2_resume")
  const resumed = store.getState("ses_b2_resume")?.roundId ?? 0
  assert.ok(resumed > firstRoundId, "resume advances the round")
  assert.ok(resumed > otherRoundId, "resume takes an id beyond every issued id")
})

test("B2: an off -> on switch takes an id greater than the one before the off", async () => {
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const before = (await store.watch("ses_b2_toggle")).roundId
  await store.unwatch("ses_b2_toggle")
  const after = (await store.watch("ses_b2_toggle")).roundId
  assert.ok(after > before, "re-watching must not reuse the old round id")
})

test("B2: hydrate() pushes the counter beyond every persisted round id", async () => {
  const storage = new FakeStorage()
  await storage.set(STORAGE_KEY, {
    ses_b2_persisted: {
      sessionID: "ses_b2_persisted",
      state: "watching",
      injections: 0,
      totalInjections: 0,
      rejections: 0,
      since: 1_000,
      roundSince: 1_000,
      endAt: 0,
      roundId: 7,
    },
  })
  const store = new WatchStore(storage)
  await store.hydrate()

  const fresh = await store.watch("ses_b2_after_hydrate")
  assert.ok(fresh.roundId > 7, "a fresh watch must not reuse a persisted round id")
  await store.resume("ses_b2_persisted")
  assert.ok(
    (store.getState("ses_b2_persisted")?.roundId ?? 0) > 7,
    "a resumed round must not reuse a persisted round id",
  )
})

test("B2: a stale verification PASS cannot mark the round that replaced it done", async () => {
  let releaseRunner: () => void = () => {}
  let runnerStarted: () => void = () => {}
  const runnerGate = new Promise<void>((resolve) => {
    releaseRunner = resolve
  })
  const startedGate = new Promise<void>((resolve) => {
    runnerStarted = resolve
  })
  const { session, store, engine } = await makeLifecycleEngine(
    { verifyCommand: "node --version" },
    async () => {
      runnerStarted()
      await runnerGate
      return verifyVerdict(true)
    },
  )
  session.context = completedAssistantTurn
  await store.watch("ses_b2_stale_pass")

  const inflight = engine.maybeInject("ses_b2_stale_pass")
  await startedGate
  // The user switches the watch off and on again while the command runs.
  await store.unwatch("ses_b2_stale_pass")
  await store.watch("ses_b2_stale_pass")
  releaseRunner()
  await inflight

  assert.notEqual(
    store.getState("ses_b2_stale_pass")?.state,
    "done",
    "a stale PASS must not decide the new round",
  )
  assert.equal(session.prompts.length, 0, "a stale PASS must not inject")
})

test("B2: a stale verification FAIL must not add a rejection or an injection", async () => {
  let releaseRunner: () => void = () => {}
  let runnerStarted: () => void = () => {}
  const runnerGate = new Promise<void>((resolve) => {
    releaseRunner = resolve
  })
  const startedGate = new Promise<void>((resolve) => {
    runnerStarted = resolve
  })
  const { session, store, engine } = await makeLifecycleEngine(
    { verifyCommand: "node --version" },
    async () => {
      runnerStarted()
      await runnerGate
      return verifyVerdict(false)
    },
  )
  session.context = completedAssistantTurn
  await store.watch("ses_b2_stale_fail")

  const inflight = engine.maybeInject("ses_b2_stale_fail")
  await startedGate
  await store.unwatch("ses_b2_stale_fail")
  await store.watch("ses_b2_stale_fail")
  releaseRunner()
  await inflight

  assert.equal(
    store.getState("ses_b2_stale_fail")?.rejections,
    0,
    "a stale FAIL must not count a rejection on the new round",
  )
  assert.equal(session.prompts.length, 0, "a stale FAIL must not inject")
})

// --- B3: the in-flight lock vs. the per-round cache ---

test("B3: the in-flight lock survives a new watch round", async () => {
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  store.getMemory("ses_b3_lock").inFlight = true
  await store.watch("ses_b3_lock")
  assert.equal(
    store.getMemory("ses_b3_lock").inFlight,
    true,
    "the injection lock belongs to the injection lifecycle, not to the round",
  )
  assert.equal(
    store.getLock("ses_b3_lock").inFlight,
    true,
    "the stored lock itself must survive the new round",
  )
})

test("B3: watch() resets the per-round cache", async () => {
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const memory = store.getMemory("ses_b3_cache")
  memory.lastUserMessageAt = 123
  memory.pendingContinue = true
  memory.pendingContinueAt = 456
  memory.lastBusyAt = 789
  memory.lastActiveAt = 987
  memory.lastSelfInjection = { text: "我们的注入", at: 1 }
  memory.frustrationPending = true
  memory.toolFailureCount = 3

  await store.watch("ses_b3_cache")

  const fresh = store.getMemory("ses_b3_cache")
  assert.equal(fresh.lastUserMessageAt, 0)
  assert.equal(fresh.pendingContinue, false)
  assert.equal(fresh.pendingContinueAt, 0)
  assert.equal(fresh.lastBusyAt, 0)
  assert.equal(fresh.lastActiveAt, 0)
  assert.equal(fresh.lastSelfInjection, undefined)
  assert.equal(fresh.frustrationPending, false)
  assert.equal(fresh.toolFailureCount, 0)
})

test("B3: unwatch() clears the lock as well as the round cache", async () => {
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  store.getMemory("ses_b3_unwatch").inFlight = true
  await store.watch("ses_b3_unwatch")
  await store.unwatch("ses_b3_unwatch")
  assert.equal(store.getMemory("ses_b3_unwatch").inFlight, false)
})

test("B3: an in-flight injection blocks the injection of the new round", async () => {
  const { session, store, engine } = await makeLifecycleEngine()
  store.getMemory("ses_b3_inflight").inFlight = true
  await store.watch("ses_b3_inflight")
  await engine.maybeInject("ses_b3_inflight")
  assert.equal(session.prompts.length, 0, "a running injection must not be duplicated")
})

// --- B4: the disposed guard ---

test("B4: a disposed engine ignores events and changes no state", async () => {
  const { session, store, engine } = await makeLifecycleEngine()
  await store.watch("ses_b4_disposed")
  const roundIdBefore = store.getState("ses_b4_disposed")?.roundId

  engine.dispose()
  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_b4_disposed",
    data: { item: { type: "user", payload: { text: "用户新消息" } } },
  })

  assert.equal(store.getMemory("ses_b4_disposed").lastUserMessageAt, 0)
  assert.equal(store.getState("ses_b4_disposed")?.roundId, roundIdBefore)
  assert.equal(store.getState("ses_b4_disposed")?.injections, 0)
  assert.equal(session.prompts.length, 0)
})

test("B4: a disposed engine never fires a scheduled injection", async () => {
  const { session, store, engine } = await makeLifecycleEngine({ intervalMs: 20 })
  await store.watch("ses_b4_timer")
  session.context = ordinaryAssistantTurn

  // Both timer kinds are armed before the engine is disposed.
  engine.scheduleInterval("ses_b4_timer")
  engine.scheduleInjection("ses_b4_timer", 10)
  engine.dispose()

  await sleep(120)
  assert.equal(session.prompts.length, 0, "a disposed engine must not inject")
})

// --- B5: the final-check race ---

test("B5 control: the final check is injected while the session stays watched", async () => {
  const { session, store, engine } = await makeLifecycleEngine()
  session.context = completedAssistantTurn
  await store.watch("ses_b5_control")

  await engine.maybeInject("ses_b5_control")

  assert.equal(session.prompts.length, 1, "the final check must be injected")
  assert.equal(store.getState("ses_b5_control")?.state, "confirming")
})

test("B5: the final check is not injected when the session was switched off meanwhile", async () => {
  const { session, store, engine } = await makeLifecycleEngine()
  session.context = completedAssistantTurn
  await store.watch("ses_b5_race")

  const beginConfirming = store.beginConfirming.bind(store)
  store.beginConfirming = async (sessionID: string) => {
    await beginConfirming(sessionID)
    // The user runs /autocontinue off while the transition is in flight.
    await store.unwatch(sessionID)
  }

  await engine.maybeInject("ses_b5_race")

  assert.equal(
    session.prompts.length,
    0,
    "no final check may be injected into a session that is no longer watched",
  )
  assert.equal(store.getState("ses_b5_race"), undefined)
})

test("B5: the event path does not inject the final check after an off", async () => {
  const { session, store, engine } = await makeLifecycleEngine()
  session.context = completedAssistantTurn
  await store.watch("ses_b5_event")

  store.beginConfirming = async (sessionID: string) => {
    await store.unwatch(sessionID)
  }

  await engine.handleEvent({
    type: "message.updated",
    sessionID: "ses_b5_event",
    properties: {
      info: { role: "assistant", id: "msg_b5_event", sessionID: "ses_b5_event" },
    },
  })

  assert.equal(session.prompts.length, 0, "the event path must not inject either")
  assert.equal(store.getState("ses_b5_event"), undefined)
})

// --- B6: the timer clamp ---

test("B6: clampTimerDelay keeps every delay inside the safe timer range", () => {
  assert.equal(clampTimerDelay(MAX_TIMER_DELAY_MS + 1), MAX_TIMER_DELAY_MS)
  assert.equal(clampTimerDelay(1_000), 1_000)
  assert.equal(clampTimerDelay(-1), 0)
  assert.equal(clampTimerDelay(Number.POSITIVE_INFINITY), MAX_TIMER_DELAY_MS)
  assert.equal(clampTimerDelay(Number.NaN), MAX_TIMER_DELAY_MS)
})

test("B6: an over-long interval or idle delay never fires early", async () => {
  const { session, store, engine } = await makeLifecycleEngine({
    intervalMs: 3_000_000_000,
    idleDelayMs: 3_000_000_000,
  })
  await store.watch("ses_b6_clamp")
  session.context = ordinaryAssistantTurn

  engine.scheduleInterval("ses_b6_clamp")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_b6_clamp" })

  await sleep(120)
  assert.equal(session.prompts.length, 0, "a clamped timer must not fire immediately")
})

test("B6: an over-long min interval never fires the follow-up injection early", async () => {
  const { session, store, engine } = await makeLifecycleEngine({ minIntervalMs: 3_000_000_000 })
  await store.watch("ses_b6_min")
  session.context = ordinaryAssistantTurn

  await engine.maybeInject("ses_b6_min")
  assert.equal(session.prompts.length, 1, "the first injection goes through")
  await engine.maybeInject("ses_b6_min")

  await sleep(120)
  assert.equal(session.prompts.length, 1, "the min-interval gate must not fire early")
})

// --- B7: the config reads ---

test("B7: an event for an unwatched session costs no config read", async () => {
  let configReads = 0
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session as any,
    () => {
      configReads += 1
      return { ...DEFAULT_CONFIG }
    },
    store,
    () => {},
  )

  await engine.handleEvent({ type: "session.idle", sessionID: "ses_b7_unwatched" })

  assert.equal(configReads, 0, "an unwatched session must not read the config")
})

test("B7: the self-echo check of a watched session costs exactly one config read", async () => {
  let configReads = 0
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session as any,
    () => {
      configReads += 1
      return { ...DEFAULT_CONFIG }
    },
    store,
    () => {},
  )
  await store.watch("ses_b7_echo")
  store.getMemory("ses_b7_echo").lastSelfInjection = { text: "我们的注入", at: Date.now() }

  await engine.handleEvent({
    type: "session.inbox.enqueued",
    sessionID: "ses_b7_echo",
    data: { item: { type: "user", payload: { text: "我们的注入" } } },
  })

  assert.equal(configReads, 1, "the echo check must not read the config a second time")
})

test("B7: a watched session costs exactly one config read per event", async () => {
  let configReads = 0
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session as any,
    () => {
      configReads += 1
      return { ...DEFAULT_CONFIG }
    },
    store,
    () => {},
  )
  await store.watch("ses_b7_watched")

  await engine.handleEvent({
    type: "session.status",
    sessionID: "ses_b7_watched",
    properties: { status: { type: "busy" } },
  })

  assert.equal(configReads, 1)
})

// --- B8 / B9: the source shape ---

test("B8: src/engine.ts uses no standalone cfg identifier", () => {
  const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf-8")
  // Comments are exempt: they may mention the old name while explaining the
  // rename. The word boundary keeps `pluginConfig` intact.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
  assert.equal(
    /\bcfg\b/.test(withoutComments),
    false,
    "src/engine.ts must not use a bare `cfg` identifier",
  )
})

test("B9: the EventLike interface declares the optional status and error fields", () => {
  const source = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf-8")
  const interfaceBlock = /export interface EventLike \{[\s\S]*?\n\}/.exec(source)?.[0] ?? ""
  assert.notEqual(interfaceBlock, "", "src/engine.ts must declare the EventLike interface")
  assert.match(interfaceBlock, /status\?:\s*unknown/)
  assert.match(interfaceBlock, /error\?:\s*unknown/)
})

// --- the harness guard itself ---

test("the harness reports an engine that was never disposed", () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  createEngine(session as any, () => ({ ...DEFAULT_CONFIG }), store, () => {})

  assert.throws(
    () => assertNoLiveEngines(),
    /still live/,
    "the guard must fail while an engine is alive",
  )
  assert.throws(
    () => assertNoLiveEngines(),
    /engine-lifecycle\.test\.ts/,
    "the guard must name the test file",
  )

  disposeEngines()
  assert.doesNotThrow(() => assertNoLiveEngines(), "the guard must pass after the cleanup")
})

test("the harness reports an engine whose dispose() does nothing", () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  const engine = createEngine(session as any, () => ({ ...DEFAULT_CONFIG }), store, () => {})
  // A test that replaces dispose() with a no-op leaves the engine alive.
  engine.dispose = () => {}

  let reported: unknown
  try {
    disposeEngines()
  } catch (error) {
    reported = error
  }

  assert.ok(reported instanceof Error, "the guard must fail when an engine stays alive")
  assert.match((reported as Error).message, /left undisposed/)
  assert.match((reported as Error).message, /engine-lifecycle\.test\.ts/, "the guard must name the test file")
})
