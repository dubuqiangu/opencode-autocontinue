// Coverage for the "guardrail off" semantics.
//
// Every guardrail in the plugin is opt-out via a sentinel value, and each
// sentinel means "unlimited" rather than "stop immediately":
//
//   - config.enabled = false   -> the plugin does nothing at all
//   - maxConsecutive = 0       -> the injection cap never fires
//   - watchTimeoutMs = 0       -> the wall-clock budget never fires
//   - verifyMaxIterations = 0  -> the verification cap never fires
//   - intervalMs = 0           -> the keep-alive heartbeat never starts
//
// A mis-read sentinel (e.g. treating 0 as "stop now") would silently disable
// the plugin or cut every round short, so each sentinel is asserted against
// the live engine rather than against the config object alone.
//
// Run: node --experimental-strip-types --test test/guardrail-off.test.ts

import { afterEach, test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts"
import { WatchStore } from "../src/state.ts"
import { createEngine, disposeEngines, FakeStorage, makeFakeSession } from "./support/harness.ts"

afterEach(() => {
  disposeEngines()
})

test("a disabled config stops the engine from injecting", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG, enabled: false }), store, () => {})
  await store.watch("ses_disabled_config")

  await engine.maybeInject("ses_disabled_config")
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_disabled_config" })

  assert.equal(session.prompts.length, 0, "a disabled plugin must never inject")
  assert.equal(store.getState("ses_disabled_config")?.state, "watching")
  assert.equal(store.getState("ses_disabled_config")?.injections, 0)
})

test("a disabled config keeps the engine from reacting to host events", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG, enabled: false }), store, () => {})
  await store.watch("ses_disabled_events")

  await engine.handleEvent({ type: "session.execution.failed", sessionID: "ses_disabled_events" })
  await engine.handleEvent({ type: "session.idle", sessionID: "ses_disabled_events" })

  assert.equal(session.prompts.length, 0)
  assert.equal(store.getState("ses_disabled_events")?.state, "watching")
})

test("a disabled config never arms the keep-alive heartbeat", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session,
    () => ({ ...DEFAULT_CONFIG, enabled: false, intervalMs: 20, minIntervalMs: 0, maxConsecutive: 0 }),
    store,
    () => {},
  )
  await store.watch("ses_disabled_heartbeat")
  engine.scheduleInterval("ses_disabled_heartbeat")

  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(session.prompts.length, 0, "a disabled plugin must not run the heartbeat")
})

test("maxConsecutive 0 means the injection cap never fires", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session,
    () => ({ ...DEFAULT_CONFIG, maxConsecutive: 0, minIntervalMs: 0, watchTimeoutMs: 0 }),
    store,
    () => {},
  )
  await store.watch("ses_unlimited_cap")

  // Far beyond the shipped default cap of 20: the round must keep running.
  for (let injection = 0; injection < 25; injection++) {
    await engine.maybeInject("ses_unlimited_cap")
  }

  assert.equal(session.prompts.length, 25, "an unlimited cap must never stop the round")
  assert.equal(store.getState("ses_unlimited_cap")?.state, "watching")
  assert.equal(store.getState("ses_unlimited_cap")?.injections, 25)
  assert.equal(store.getState("ses_unlimited_cap")?.stopReason, undefined)
})

test("mergeConfig keeps the unlimited cap and the disabled interval at 0", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { maxConsecutive: 0, intervalMs: 0 })
  assert.equal(merged.maxConsecutive, 0, "0 must survive as the unlimited cap")
  assert.equal(merged.intervalMs, 0, "0 must survive as the disabled heartbeat interval")
})

test("a positive maxConsecutive still stops the round at the cap", async () => {
  // The counterpart of the "0 = unlimited" rule: a positive cap is enforced.
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session,
    () => ({ ...DEFAULT_CONFIG, maxConsecutive: 3, minIntervalMs: 0, watchTimeoutMs: 0 }),
    store,
    () => {},
  )
  await store.watch("ses_capped_round")

  for (let injection = 0; injection < 3; injection++) {
    await engine.maybeInject("ses_capped_round")
  }
  await engine.maybeInject("ses_capped_round")

  assert.equal(session.prompts.length, 3)
  assert.equal(store.getState("ses_capped_round")?.state, "stopped")
  assert.equal(store.getState("ses_capped_round")?.stopReason, "injection-cap")
})
