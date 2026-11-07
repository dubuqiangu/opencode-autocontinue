// Shared test harness for the opencode-autocontinue suite.
//
// Two problems this file solves for every test module:
//
// 1. Engine lifecycle. An AutocontinueEngine owns timers (scheduleInjection's
//    setTimeout and scheduleInterval's setInterval). A test that forgets to
//    dispose it leaves live handles behind and `node --test` never returns.
//    createEngine() registers every instance; disposeEngines() (called from
//    each file's afterEach hook) releases them.
//
// 2. Deterministic time. The wall-clock budget, the min-interval gate and the
//    round budget all read Date.now(). withFakeClock() replaces the global
//    Date with a movable fake so those gates can be exercised without real
//    sleeps.
//
// This module is NOT a *.test.ts file: `node --test "test/*.test.ts"` only
// picks up the test modules, never this helper.
//
// test/server.test.ts uses these fixtures as well: the engine lifecycle
// registry, the fake storage and the fake session are shared by every test
// module, so the repo holds exactly ONE FakeStorage and ONE makeFakeSession
// implementation - never add a second copy.

import { AutocontinueEngine } from "../../src/engine.ts"
import type { PluginConfig } from "../../src/config.ts"
import { WatchStore } from "../../src/state.ts"
import type { WatchStatusEvent } from "../../src/rpc.ts"
import type { SpawnSpec, VerifyResult } from "../../src/verify.ts"

/** In-memory stand-in for ctx.storage. */
export class FakeStorage {
  private readonly data = new Map<string, unknown>()
  async get(key: string): Promise<unknown> {
    return this.data.get(key)
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value)
  }
}

export interface FakeSession {
  prompts: string[]
  hooks: Array<{ name: string; callback: (event: any) => void | Promise<void> }>
  prompt(input: { sessionID: string; text: string }): Promise<void>
  hook(name: string, callback: (event: any) => void | Promise<void>): Promise<void>
  context(input: { sessionID: string }): Promise<readonly unknown[]>
  get(input: { sessionID: string }): Promise<unknown>
}

/**
 * A fake host session. `messages` supplies the conversation the engine reads
 * (V1 info/parts shape by default); `title` supplies the session title the
 * title-exclusion filter inspects.
 */
export function makeFakeSession(
  options: { messages?: () => Promise<readonly unknown[]>; title?: string } = {},
): FakeSession {
  const session: FakeSession = {
    prompts: [],
    hooks: [],
    async prompt(input) {
      session.prompts.push(input.text)
    },
    async hook(name, callback) {
      session.hooks.push({ name, callback })
    },
    async context() {
      return options.messages ? await options.messages() : []
    },
    async get() {
      return options.title === undefined ? null : { title: options.title }
    },
  }
  return session
}

const liveEngines = new Set<AutocontinueEngine>()

/** Construct an engine and register it for disposal by disposeEngines(). */
export function createEngine(
  session: unknown,
  config: () => PluginConfig,
  store: WatchStore,
  emitChanged: (event: WatchStatusEvent) => void,
  verifyRunner?: (spec: SpawnSpec) => Promise<VerifyResult>,
  baseDirectory?: string,
): AutocontinueEngine {
  const engine = new AutocontinueEngine(
    session as any,
    config,
    store,
    emitChanged,
    verifyRunner,
    baseDirectory,
  )
  liveEngines.add(engine)
  return engine
}

/** Dispose every engine created through createEngine() and forget them. */
export function disposeEngines(): void {
  for (const engine of liveEngines) engine.dispose()
  liveEngines.clear()
}

export interface FakeClock {
  /** Current fake epoch milliseconds. */
  now(): number
  /** Move the fake clock forward by `milliseconds`. */
  advance(milliseconds: number): void
}

/**
 * Run `run` with the global Date frozen at `startEpochMs`. The clock can be
 * moved forward with clock.advance(); the real Date is restored afterwards.
 */
export async function withFakeClock(
  startEpochMs: number,
  run: (clock: FakeClock) => void | Promise<void>,
): Promise<void> {
  const RealDate = Date
  let currentEpochMs = startEpochMs
  class FakeDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(currentEpochMs)
      else super(...args)
    }
    static now(): number {
      return currentEpochMs
    }
  }
  ;(globalThis as any).Date = FakeDate
  const clock: FakeClock = {
    now: () => currentEpochMs,
    advance: (milliseconds: number) => {
      currentEpochMs += milliseconds
    },
  }
  try {
    await run(clock)
  } finally {
    ;(globalThis as any).Date = RealDate
  }
}
