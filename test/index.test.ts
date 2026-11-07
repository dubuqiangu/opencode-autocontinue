// Coverage for src/index.ts — the server entry point.
//
// src/index.ts is the ONLY module that wires everything together: it loads the
// config, hydrates the watch store, builds the engine, registers the RPC
// implementation, installs the retry hook, subscribes to the host event
// stream and returns the cleanup function that tears all of that down.
//
// The tests below drive the entry through its public surface only: a fake
// host context (storage / session / event / rpc) plus the cleanup function
// returned by setup(). Nothing internal is stubbed, so the wiring itself is
// under test.
//
// Two isolation concerns:
//
//  1. loadConfig() reads the GLOBAL config from the user's home directory
//     (~/.config/opencode/opencode-autocontinue.jsonc). Every test points the
//     home directory at a throwaway temp dir (os.homedir() honours USERPROFILE
//     on Windows and HOME on POSIX) so the developer's real config — which
//     carries an endTime window — cannot influence the result.
//
//  2. The engine built inside setup() owns timers. setup() returns a cleanup
//     function that disposes them; every test calls it (the afterEach hook
//     disposes any leftover), so the suite never leaves a live handle behind.
//
// Run: node --experimental-strip-types --test test/index.test.ts

import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin, { id, setup } from "../src/index.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { AUTOCONTINUE_RPC_CONTRACT, AUTOCONTINUE_RPC_ID } from "../src/rpc.ts"
import type { EventLike } from "../src/events.ts"
import { FakeStorage, makeFakeSession } from "./support/harness.ts"

const originalUserProfile = process.env.USERPROFILE
const originalHome = process.env.HOME
const originalAutocontinueSwitch = process.env.OC_AUTOCONTINUE
const temporaryDirectories: string[] = []
const pendingCleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalAutocontinueSwitch === undefined) delete process.env.OC_AUTOCONTINUE
  else process.env.OC_AUTOCONTINUE = originalAutocontinueSwitch

  while (pendingCleanups.length > 0) {
    const cleanup = pendingCleanups.pop()
    if (cleanup) await cleanup()
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
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

interface FakeHost {
  ctx: Record<string, any>
  /** Events pushed to the host event stream. */
  events: FakeEventStream
  /** Payloads received through the RPC event emitter. */
  emitted: Array<{ name: string; data: Record<string, unknown> }>
  /** The implementation handed to ctx.rpc.register. */
  implementation: Record<string, any>
  /** The contract handed to ctx.rpc.register. */
  contract: unknown
  /** Whether the RPC registration was disposed. */
  rpcDisposed: boolean
}

/** A controllable host event stream that honours the abort signal. */
class FakeEventStream {
  private readonly queue: EventLike[] = []
  private readonly waiters: Array<(result: IteratorResult<EventLike>) => void> = []
  private closed = false

  get isClosed(): boolean {
    return this.closed
  }

  push(event: EventLike): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.queue.push(event)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ value: undefined as unknown as EventLike, done: true })
    }
  }

  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<EventLike> {
    // Capture the stream: inside the iterator methods `this` is the iterator,
    // not the stream, so the queue and the waiter list must be reached
    // through the captured reference.
    const stream = this
    options?.signal?.addEventListener("abort", () => stream.close())
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<EventLike>> {
            const queued = stream.queue.shift()
            if (queued) return Promise.resolve({ value: queued, done: false })
            if (stream.closed) return Promise.resolve({ value: undefined as unknown as EventLike, done: true })
            return new Promise((resolve) => stream.waiters.push(resolve))
          },
          return(): Promise<IteratorResult<EventLike>> {
            stream.close()
            return Promise.resolve({ value: undefined as unknown as EventLike, done: true })
          },
        }
      },
    }
  }
}

/**
 * Build a fake host with an isolated home directory and a project config that
 * makes the timing deterministic (no keep-alive interval, no injection cap, no
 * wall-clock budget, a 10ms idle delay).
 */
function createFakeHost(): FakeHost {
  const homeDirectory = mkdtempSync(join(tmpdir(), "opencode-autocontinue-home-"))
  const projectDirectory = mkdtempSync(join(tmpdir(), "opencode-autocontinue-project-"))
  temporaryDirectories.push(homeDirectory, projectDirectory)
  process.env.USERPROFILE = homeDirectory
  process.env.HOME = homeDirectory
  delete process.env.OC_AUTOCONTINUE

  mkdirSync(join(projectDirectory, ".opencode"), { recursive: true })
  writeFileSync(
    join(projectDirectory, ".opencode", "opencode-autocontinue.jsonc"),
    JSON.stringify({
      idleDelayMs: 10,
      intervalMs: 0,
      minIntervalMs: 0,
      watchTimeoutMs: 0,
      maxConsecutive: 0,
      excludeTitleKeywords: [],
    }),
    "utf-8",
  )

  const events = new FakeEventStream()
  const emitted: Array<{ name: string; data: Record<string, unknown> }> = []
  const host: FakeHost = {
    ctx: {},
    events,
    emitted,
    implementation: {},
    contract: undefined,
    rpcDisposed: false,
  }

  const session = makeFakeSession()
  host.ctx = {
    location: { directory: projectDirectory },
    storage: new FakeStorage(),
    session,
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => events.subscribe(options),
    },
    rpc: {
      async register(contract: unknown, implementation: unknown) {
        host.contract = contract
        host.implementation = implementation as Record<string, any>
        return {
          events: {
            async emit(name: string, data: Record<string, unknown>) {
              emitted.push({ name, data })
            },
          },
          async dispose() {
            host.rpcDisposed = true
          },
        }
      },
    },
  }
  return host
}

/** Run setup() with the fake host and register the returned cleanup. */
async function startPlugin(host: FakeHost): Promise<() => Promise<void>> {
  const cleanup = await setup(host.ctx)
  pendingCleanups.push(cleanup)
  return cleanup
}

test("the plugin exports the shared RPC id", () => {
  assert.equal(id, AUTOCONTINUE_RPC_ID)
  assert.equal(plugin.id, AUTOCONTINUE_RPC_ID)
  assert.equal(typeof plugin.setup, "function")
})

test("setup registers the shared RPC contract with the host", async () => {
  const host = createFakeHost()
  await startPlugin(host)

  assert.equal(host.contract, AUTOCONTINUE_RPC_CONTRACT, "the host must receive the very same contract object")
  assert.equal(typeof host.implementation.set, "function")
  assert.equal(typeof host.implementation.status, "function")
  assert.equal(typeof host.implementation.list, "function")
})

test("setup installs the retry hook on the host session", async () => {
  const host = createFakeHost()
  await startPlugin(host)

  const session = host.ctx.session
  const hookNames = session.hooks.map((entry: { name: string }) => entry.name)
  assert.ok(hookNames.includes("retry"), "the retry hook must be installed during setup")
})

test("rpc.set enables watching for a session", async () => {
  const host = createFakeHost()
  await startPlugin(host)

  const result = await host.implementation.set({ sessionID: "ses_enabled", enabled: true })
  assert.equal(result.state, "watching")

  const status = await host.implementation.status({ sessionID: "ses_enabled" })
  assert.equal(status.watched, true)
  assert.equal(status.state.sessionID, "ses_enabled")
  assert.equal(status.state.state, "watching")
  assert.equal(status.state.injections, 0)
})

test("rpc.set disables watching for a session", async () => {
  const host = createFakeHost()
  await startPlugin(host)

  await host.implementation.set({ sessionID: "ses_disabled", enabled: true })
  const result = await host.implementation.set({ sessionID: "ses_disabled", enabled: false })
  assert.equal(result.state, "stopped")

  const status = await host.implementation.status({ sessionID: "ses_disabled" })
  assert.equal(status.watched, false)
  assert.equal(status.state, undefined, "an unwatched session carries no state payload")
})

test("rpc.list reports the watched sessions", async () => {
  const host = createFakeHost()
  await startPlugin(host)

  const empty = await host.implementation.list()
  assert.deepEqual(empty.sessions, [])

  await host.implementation.set({ sessionID: "ses_listed", enabled: true })
  const listed = await host.implementation.list()
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].sessionID, "ses_listed")
  assert.equal(listed.sessions[0].state, "watching")
})

test("rpc.status reports an unwatched session", async () => {
  const host = createFakeHost()
  await startPlugin(host)

  const status = await host.implementation.status({ sessionID: "ses_unknown" })
  assert.equal(status.watched, false)
  assert.equal(status.state, undefined)
})

test("rpc.set emits a state.changed event for the host footer", async () => {
  const host = createFakeHost()
  await startPlugin(host)

  await host.implementation.set({ sessionID: "ses_emitted", enabled: true })

  assert.ok(
    await waitFor(() => host.emitted.some((event) => event.name === "state.changed")),
    "rpc.set must emit a state.changed event",
  )
  const event = host.emitted.find((entry) => entry.name === "state.changed")!
  assert.equal(event.data.sessionID, "ses_emitted")
  assert.equal(event.data.state, "watching")
  assert.equal(event.data.injections, 0)
  assert.equal(
    Object.hasOwn(event.data, "stopReason"),
    false,
    "a live round carries no stop reason, so the key must be absent",
  )
})

test("the host event subscription drives an injection on session.idle", async () => {
  const host = createFakeHost()
  await startPlugin(host)
  const session = host.ctx.session

  await host.implementation.set({ sessionID: "ses_idle", enabled: true })
  host.events.push({ type: "session.idle", sessionID: "ses_idle" })

  assert.ok(
    await waitFor(() => session.prompts.length >= 1),
    "an idle event on a watched session must reach the injection decision",
  )
  assert.equal(
    session.prompts[0],
    DEFAULT_CONFIG.message,
    "the configured continuation message must be injected verbatim",
  )
})

test("cleanup disposes the RPC registration and closes the event subscription", async () => {
  const host = createFakeHost()
  const cleanup = await startPlugin(host)

  await cleanup()

  assert.equal(host.rpcDisposed, true, "the RPC registration must be disposed")
  assert.equal(host.events.isClosed, true, "the event subscription must be aborted")
})

test("no injection happens after the cleanup ran", async () => {
  const host = createFakeHost()
  const cleanup = await startPlugin(host)
  const session = host.ctx.session

  await host.implementation.set({ sessionID: "ses_after_cleanup", enabled: true })
  await cleanup()

  host.events.push({ type: "session.idle", sessionID: "ses_after_cleanup" })
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.equal(session.prompts.length, 0, "a disposed plugin must never inject again")
})

test("setup is a no-op when OC_AUTOCONTINUE is 0", async () => {
  const host = createFakeHost()
  process.env.OC_AUTOCONTINUE = "0"

  const cleanup = await setup(host.ctx)
  pendingCleanups.push(cleanup)

  assert.equal(host.contract, undefined, "the RPC contract must not be registered when the plugin is disabled")
  await cleanup()
})
