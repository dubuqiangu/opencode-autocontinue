// Coverage for the title-exclusion stop reason (v0.5.3).
//
// A session whose title hits excludeTitleKeywords is never auto-continued.
// Before v0.5.3 the stop was recorded with a bare markStopped(sessionID),
// which cleared the stop reason — the footer then showed "[AC ⏹ N]" with no
// phrase and the reason was indistinguishable from any other bare stop.
//
// Run: node --experimental-strip-types --test test/title-exclusion.test.ts

import { afterEach, test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { WatchStore } from "../src/state.ts"
import type { WatchStatusEvent } from "../src/rpc.ts"
import { createEngine, disposeEngines, FakeStorage, makeFakeSession } from "./support/harness.ts"

afterEach(() => {
  disposeEngines()
})

test("a title that hits excludeTitleKeywords stops the round with the title-excluded reason", async () => {
  const session = makeFakeSession({ title: "临时测试会话" })
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG }), store, () => {})
  await store.watch("ses_title_excluded")

  await engine.maybeInject("ses_title_excluded")

  assert.equal(session.prompts.length, 0, "an excluded session must never be poked")
  assert.equal(store.getState("ses_title_excluded")?.state, "stopped")
  assert.equal(store.getState("ses_title_excluded")?.stopReason, "title-excluded")
})

test("the state.changed event carries the title-excluded reason", async () => {
  const session = makeFakeSession({ title: "临时测试会话" })
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const events: WatchStatusEvent[] = []
  const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG }), store, (event) => {
    events.push(event)
  })
  await store.watch("ses_title_excluded_event")

  await engine.maybeInject("ses_title_excluded_event")

  const stoppedEvent = events.find((event) => event.state === "stopped")
  assert.ok(stoppedEvent, "the stop must be published to the TUI")
  assert.equal(stoppedEvent?.stopReason, "title-excluded")
})

test("the status payload carries the title-excluded reason under the stopReason key", async () => {
  const session = makeFakeSession({ title: "临时测试会话" })
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG }), store, () => {})
  await store.watch("ses_title_excluded_status")

  await engine.maybeInject("ses_title_excluded_status")

  const status = store.status("ses_title_excluded_status")
  assert.equal(status.state?.stopReason, "title-excluded")
  assert.equal(Object.hasOwn(status.state ?? {}, "stopReason"), true)
  const listed = store.list().find((row) => row.sessionID === "ses_title_excluded_status")
  assert.equal(listed?.stopReason, "title-excluded")
  assert.equal(Object.hasOwn(listed ?? {}, "stopReason"), true)
})

test("a live round omits the stopReason key entirely", async () => {
  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG }), store, () => {})
  await store.watch("ses_title_live_round")

  const status = store.status("ses_title_live_round")
  assert.equal(status.state?.state, "watching")
  assert.equal(
    Object.hasOwn(status.state ?? {}, "stopReason"),
    false,
    "a round without a reason must omit the key, not send an explicit undefined",
  )
})

test("a session whose title does not hit the keywords keeps watching", async () => {
  const session = makeFakeSession({ title: "生产会话" })
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(session, () => ({ ...DEFAULT_CONFIG }), store, () => {})
  await store.watch("ses_title_allowed")

  await engine.maybeInject("ses_title_allowed")

  assert.equal(session.prompts.length, 1)
  assert.equal(store.getState("ses_title_allowed")?.state, "watching")
  assert.equal(store.getState("ses_title_allowed")?.stopReason, undefined)
})
