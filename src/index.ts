// Server entry for opencode-autocontinue.
// Wires config, watch store, engine, RPC, and event subscription.

import { loadConfig } from "./config.ts"
import { WatchStore } from "./state.ts"
import { AutocontinueEngine, computeEndAt } from "./engine.ts"
import type { EventLike } from "./events.ts"
import { AUTOCONTINUE_RPC_CONTRACT, AUTOCONTINUE_RPC_ID } from "./rpc.ts"
import type { WatchStatusEvent } from "./rpc.ts"

// Minimal structural types matching the V2 plugin API surface we use.
// The runtime provides these; we avoid a hard import to keep installs light.

interface ServerContext {
  location?: { directory: string }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  session: {
    prompt(input: {
      sessionID: string
      text: string
      metadata?: Record<string, unknown>
    }): Promise<unknown>
    // Optional: hosts that support it land the injection as "synthetic";
    // older hosts fall back to prompt (still tagged with provenance metadata).
    synthetic?(input: {
      sessionID: string
      text: string
      description?: string
      metadata?: Record<string, unknown>
      resume?: boolean
    }): Promise<unknown>
    hook(name: string, callback: (event: any) => void | Promise<void>): Promise<unknown>
    context(input: { sessionID: string }): Promise<readonly unknown[]>
    get(input: { sessionID: string }): Promise<unknown>
  }
  event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<EventLike>
  }
  rpc: {
    register(contract: unknown, implementation: unknown): Promise<{
      events: { emit(name: string, data: Record<string, unknown>): Promise<void> }
      dispose(): Promise<void>
    }>
  }
}

export const id = AUTOCONTINUE_RPC_ID

export async function setup(ctx: ServerContext): Promise<() => Promise<void>> {
  if (process.env.OC_AUTOCONTINUE === "0") {
    return async () => {}
  }

  const config = () => loadConfig(ctx.location?.directory)
  const store = new WatchStore(ctx.storage)
  await store.hydrate()

  // RPC events let the TUI refresh its footer live.
  let emitStateChanged: (event: WatchStatusEvent) => Promise<void> = async () => {}
  const rpcContract = AUTOCONTINUE_RPC_CONTRACT

  // Construct the engine BEFORE rpcImplementation: rpcImplementation.set calls
  // engine.scheduleInterval/stopInterval/clearTimer/forgetSession, and
  // ctx.rpc.register runs below. Declaring engine after rpcImplementation put
  // those calls in the const's TDZ — safe only because register stores the
  // impl without synchronously invoking a method. Constructing first removes
  // the latent ReferenceError hazard. emitStateChanged is captured by
  // reference (let), so its later reassignment to the RPC emitter is visible.
  const engine = new AutocontinueEngine(
    ctx.session,
    config,
    store,
    (event) => {
      void emitStateChanged(event)
    },
    undefined,
    ctx.location?.directory,
  )

  const rpcImplementation = {
    async set(input: { sessionID: string; enabled: boolean }) {
      if (input.enabled) {
        await store.watch(input.sessionID, config().endTime ? computeEndAt(config().endTime, config().startTime) : 0)
        engine.scheduleInterval(input.sessionID)
      } else {
        // B-4: abort a running verification BEFORE unwatch() deletes the memory
        // entry (the abort controller reference lives there).
        engine.abortVerify(input.sessionID)
        await store.unwatch(input.sessionID)
        engine.stopInterval(input.sessionID)
        // P2-3: cancel any pending injection timeout so it cannot fire after
        // unwatch (then re-watch before it fires would inject spuriously).
        engine.clearTimer(input.sessionID)
        engine.forgetSession(input.sessionID)
      }
      const entry = store.getState(input.sessionID)
      const state = entry?.state ?? (input.enabled ? "watching" : "stopped")
      void emitStateChanged({
        sessionID: input.sessionID,
        state,
        injections: entry?.injections ?? 0,
        totalInjections: entry?.totalInjections ?? 0,
        rejections: entry?.rejections ?? 0,
        verifying: false,
        toolFailureCount: store.getMemory(input.sessionID).toolFailureCount,
        // Only present when the round carries a stop reason (the RPC schema
        // rejects undefined values, so the field is omitted otherwise).
        ...(entry?.stopReason !== undefined ? { stopReason: entry.stopReason } : {}),
      })
      return { state }
    },
    async status(input: { sessionID: string }) {
      return store.status(input.sessionID)
    },
    async list() {
      return { sessions: store.list() }
    },
  }

  let rpcRegistration: Awaited<ReturnType<ServerContext["rpc"]["register"]>> | undefined
  try {
    rpcRegistration = await ctx.rpc.register(rpcContract, rpcImplementation)
    emitStateChanged = async (event) => {
      try {
        await rpcRegistration?.events.emit("state.changed", { ...event })
      } catch {
        // TUI may be disconnected; footer catches up on next status check.
      }
    }
  } catch (error) {
    console.error("[opencode-autocontinue] RPC registration failed (TUI status unavailable):", error)
  }

  await engine.installRetryHook()
  // Sessions restored from storage (hydrate) should resume their keep-alive
  // heartbeat without waiting for a new /autocontinue on.
  engine.resumeKeepAlives()

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await engine.handleEvent(event)
        } catch (error) {
          console.error("[opencode-autocontinue] event handler error:", error)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("[opencode-autocontinue] event subscription ended:", error)
      }
    }
  })()

  return async () => {
    controller.abort()
    engine.dispose()
    await rpcRegistration?.dispose()
  }
}

export default { id, setup }
