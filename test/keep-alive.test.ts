// Coverage for the two periodic paths of the engine:
//   - the keep-alive heartbeat (scheduleInterval -> the unified injection
//     decision), and
//   - the minIntervalMs gate that keeps two injections apart.
//
// The heartbeat needs a real timer (setInterval is not faked), so it runs with
// a very small interval and a bounded wait. The min-interval gate is checked
// with the fake clock — no real sleeps.
//
// Run: node --experimental-strip-types --test test/keep-alive.test.ts

import { afterEach, test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { WatchStore } from "../src/state.ts"
import { createEngine, disposeEngines, FakeStorage, makeFakeSession, withFakeClock } from "./support/harness.ts"

afterEach(() => {
  disposeEngines()
})

/** Poll until `predicate` holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

test("the periodic keep-alive triggers a unified injection decision", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session,
    () => ({ ...DEFAULT_CONFIG, intervalMs: 20, minIntervalMs: 0, maxConsecutive: 0 }),
    store,
    () => {},
  )
  await store.watch("ses_keepalive")
  engine.scheduleInterval("ses_keepalive")

  assert.ok(
    await waitFor(() => session.prompts.length >= 1),
    "the keep-alive heartbeat must reach the injection decision",
  )
  assert.equal(store.getState("ses_keepalive")?.injections, 1)
  assert.equal(store.getState("ses_keepalive")?.state, "watching")
})

test("the periodic keep-alive keeps firing while the session stays idle", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session,
    () => ({ ...DEFAULT_CONFIG, intervalMs: 20, minIntervalMs: 0, maxConsecutive: 0 }),
    store,
    () => {},
  )
  await store.watch("ses_keepalive_repeat")
  engine.scheduleInterval("ses_keepalive_repeat")

  assert.ok(
    await waitFor(() => session.prompts.length >= 3),
    "the keep-alive heartbeat must fire repeatedly, not only once",
  )
  assert.ok((store.getState("ses_keepalive_repeat")?.injections ?? 0) >= 3)
})

test("the periodic keep-alive injects nothing for a session that is not watched", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session,
    () => ({ ...DEFAULT_CONFIG, intervalMs: 20, minIntervalMs: 0, maxConsecutive: 0 }),
    store,
    () => {},
  )
  engine.scheduleInterval("ses_keepalive_unwatched")

  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(session.prompts.length, 0, "an unwatched session must never be poked")
})

test("stopping the keep-alive stops the periodic injections", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(
    session,
    () => ({ ...DEFAULT_CONFIG, intervalMs: 20, minIntervalMs: 0, maxConsecutive: 0 }),
    store,
    () => {},
  )
  await store.watch("ses_keepalive_stopped")
  engine.scheduleInterval("ses_keepalive_stopped")
  assert.ok(await waitFor(() => session.prompts.length >= 1))

  engine.stopInterval("ses_keepalive_stopped")
  const injectionsAtStop = session.prompts.length
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(session.prompts.length, injectionsAtStop, "no injection may arrive after the heartbeat stopped")
})

test("minIntervalMs defers a second injection inside the window", async () => {
  await withFakeClock(1_700_000_000_000, async (clock) => {
    const session = makeFakeSession()
    const store = new WatchStore(new FakeStorage())
    await store.hydrate()
    const engine = createEngine(
      session,
      () => ({ ...DEFAULT_CONFIG, intervalMs: 0, minIntervalMs: 5_000, maxConsecutive: 0 }),
      store,
      () => {},
    )
    await store.watch("ses_min_interval")
    await engine.maybeInject("ses_min_interval")
    assert.equal(session.prompts.length, 1)
    const firstInjectionAt = store.getState("ses_min_interval")?.lastInjectedAt
    assert.equal(firstInjectionAt, 1_700_000_000_000)

    // One second into the 5s window: the next injection must be held back.
    clock.advance(1_000)
    await engine.maybeInject("ses_min_interval")
    assert.equal(session.prompts.length, 1, "the second injection must be deferred inside the window")
    assert.equal(store.getState("ses_min_interval")?.state, "watching")
    assert.equal(store.getState("ses_min_interval")?.injections, 1)
  })
})

test("minIntervalMs allows the next injection once the window has passed", async () => {
  await withFakeClock(1_700_000_000_000, async (clock) => {
    const session = makeFakeSession()
    const store = new WatchStore(new FakeStorage())
    await store.hydrate()
    const engine = createEngine(
      session,
      () => ({ ...DEFAULT_CONFIG, intervalMs: 0, minIntervalMs: 5_000, maxConsecutive: 0 }),
      store,
      () => {},
    )
    await store.watch("ses_min_interval_expired")
    await engine.maybeInject("ses_min_interval_expired")
    assert.equal(session.prompts.length, 1)

    clock.advance(1_000)
    await engine.maybeInject("ses_min_interval_expired")
    assert.equal(session.prompts.length, 1, "still inside the window")

    clock.advance(5_000)
    await engine.maybeInject("ses_min_interval_expired")
    assert.equal(session.prompts.length, 2, "the window has passed, the injection must go through")
    assert.equal(store.getState("ses_min_interval_expired")?.injections, 2)
    assert.equal(store.getState("ses_min_interval_expired")?.state, "watching")
  })
})
