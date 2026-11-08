// Shared test harness for the opencode-autocontinue suite.
//
// Three problems this file solves for every test module:
//
// 1. Engine lifecycle. An AutocontinueEngine owns timers (scheduleInjection's
//    setTimeout and scheduleInterval's setInterval). A test that forgets to
//    dispose it leaves live handles behind and `node --test` never returns.
//    createEngine() registers every instance; disposeEngines() (called from
//    each file's afterEach hook) releases them. disposeEngines() ALSO checks
//    that every registered engine really ended up disposed and throws with
//    the owning test file / test name when one did not, so a leaked engine is
//    reported instead of silently keeping the process alive.
//
// 2. Deterministic time. The wall-clock budget, the min-interval gate and the
//    round budget all read Date.now(). withFakeClock() replaces the global
//    Date with a movable fake so those gates can be exercised without real
//    sleeps. There is exactly ONE clock helper in the repo - never add a
//    second one.
//
// 3. A host-shaped fake session. makeFakeSession() mimics ctx.session: it
//    records every injection (text + provenance metadata + the channel it was
//    delivered through), answers context() / get() and captures hooks.
//
// This module is NOT a *.test.ts file: `node --test "test/*.test.ts"` only
// picks up the test modules, never this helper.
//
// test/server.test.ts uses these fixtures as well: the engine lifecycle
// registry, the fake storage and the fake session are shared by every test
// module, so the repo holds exactly ONE FakeStorage and ONE makeFakeSession
// implementation - never add a second copy.

import { beforeEach } from "node:test"
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

/** One injection the engine delivered into the fake host. */
export interface RecordedInjection {
  /** The rendered continuation text that was sent. */
  text: string
  /** The provenance metadata that was sent along with the text. */
  metadata?: Record<string, unknown>
  /** The host channel the injection went through. */
  channel: "synthetic" | "prompt"
}

export interface FakeSession {
  /** The text of every injection, in delivery order (kept for the many
   *  existing assertions that only care about the text). */
  prompts: string[]
  /** Every injection with its provenance metadata and delivery channel. */
  injections: RecordedInjection[]
  hooks: Array<{ name: string; callback: (event: any) => void | Promise<void> }>
  prompt(input: {
    sessionID: string
    text: string
    metadata?: Record<string, unknown>
  }): Promise<void>
  /** Present only when the fake host supports the synthetic channel. */
  synthetic?(input: {
    sessionID: string
    text: string
    description?: string
    metadata?: Record<string, unknown>
    resume?: boolean
  }): Promise<void>
  hook(name: string, callback: (event: any) => void | Promise<void>): Promise<void>
  context(input: { sessionID: string }): Promise<readonly unknown[]>
  get(input: { sessionID: string }): Promise<unknown>
}

/**
 * A fake host session. `messages` supplies the conversation the engine reads
 * (V1 info/parts shape by default); `title` supplies the session title the
 * title-exclusion filter inspects.
 *
 * `supportsSynthetic` models the two host generations: false (the default)
 * is an older host without the synthetic channel, so the injection falls back
 * to prompt(); true is a host that supports synthetic() and therefore receives
 * the injection through that channel.
 */
export function makeFakeSession(
  options: {
    messages?: () => Promise<readonly unknown[]>
    title?: string
    supportsSynthetic?: boolean
  } = {},
): FakeSession {
  const session: FakeSession = {
    prompts: [],
    injections: [],
    hooks: [],
    async prompt(input) {
      session.prompts.push(input.text)
      session.injections.push({
        text: input.text,
        metadata: input.metadata,
        channel: "prompt",
      })
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
  if (options.supportsSynthetic) {
    session.synthetic = async (input) => {
      // The text is recorded in `prompts` as well: an injection is an
      // injection, no matter which channel carried it.
      session.prompts.push(input.text)
      session.injections.push({
        text: input.text,
        metadata: input.metadata,
        channel: "synthetic",
      })
    }
  }
  return session
}

/** Bookkeeping for one engine created through createEngine(). */
interface EngineRegistration {
  engine: AutocontinueEngine
  /** The test file that created the engine (best effort). */
  ownerFile: string
  /** The test that created the engine. */
  ownerTest: string
  /** Ordinal of the engine inside the owning test file. */
  ordinal: number
  /** Set by the wrapped dispose() below. */
  disposed: boolean
}

/** The test that is currently running (node:test reports it through a hook). */
let currentTestName = "(outside a test)"

beforeEach((context) => {
  currentTestName = context.name
})

/** The test file that is currently running (best effort, from the argv). */
function currentTestFile(): string {
  const entry = process.argv[1]
  if (!entry) return "(unknown test file)"
  return entry.split(/[\\/]/).pop() ?? entry
}

const engineRegistry = new Map<AutocontinueEngine, EngineRegistration>()
let engineOrdinal = 0

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
  const registration: EngineRegistration = {
    engine,
    ownerFile: currentTestFile(),
    ownerTest: currentTestName,
    ordinal: ++engineOrdinal,
    disposed: false,
  }
  // Wrap dispose() so a manual disposal is registered as well - and so a
  // test that replaces dispose() with a no-op is caught by the guard.
  const disposeEngine = engine.dispose.bind(engine)
  engine.dispose = () => {
    disposeEngine()
    registration.disposed = true
    engineRegistry.delete(engine)
  }
  engineRegistry.set(engine, registration)
  return engine
}

/** True when the engine really carries the disposed flag (a replaced
 *  dispose() that does nothing leaves it false). */
function reallyDisposed(registration: EngineRegistration): boolean {
  const internalFlag = (registration.engine as unknown as { disposed?: boolean }).disposed
  return registration.disposed && internalFlag === true
}

function describeEngines(registrations: EngineRegistration[]): string {
  return registrations
    .map(
      (registration) =>
        `${registration.ownerFile} :: ${registration.ownerTest} (engine #${registration.ordinal})`,
    )
    .join("; ")
}

/**
 * Dispose every engine created through createEngine() and forget them.
 *
 * Throws when an engine could not be disposed (for example because a test
 * replaced dispose() with a no-op), naming the test file and the test that
 * created it. The engines are forgotten either way, so one broken engine is
 * reported once instead of failing every later test.
 */
export function disposeEngines(): void {
  const registrations = [...engineRegistry.values()]
  for (const registration of registrations) {
    try {
      registration.engine.dispose()
    } catch {
      // Keep disposing the rest: one broken engine must not hide the others.
    }
  }
  const leaked = registrations.filter((registration) => !reallyDisposed(registration))
  engineRegistry.clear()
  if (leaked.length > 0) {
    throw new Error(
      `[harness] ${leaked.length} engine(s) were left undisposed: ${describeEngines(leaked)}`,
    )
  }
}

/**
 * Assert that no engine created through createEngine() is still alive.
 * Call it at the end of a test that is expected to clean up after itself.
 */
export function assertNoLiveEngines(): void {
  if (engineRegistry.size === 0) return
  const leaked = [...engineRegistry.values()]
  throw new Error(
    `[harness] ${leaked.length} engine(s) are still live: ${describeEngines(leaked)}. ` +
      "Dispose them (engine.dispose() or disposeEngines()) before the test ends.",
  )
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
