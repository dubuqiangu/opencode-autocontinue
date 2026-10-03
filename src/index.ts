// Server entry for opencode-autocontinue.
// Wires config, watch store, engine, RPC, and event subscription.

import { loadConfig } from "./config.ts"
import { WatchStore } from "./state.ts"
import { AutocontinueEngine, computeEndAt } from "./engine.ts"
import type { EventLike } from "./events.ts"
import { AUTOCONTINUE_RPC_CONTRACT, AUTOCONTINUE_RPC_ID } from "./rpc.ts"

// Minimal structural types matching the V2 plugin API surface we use.
// The runtime provides these; we avoid a hard import to keep installs light.

interface ServerContext {
  location?: { directory: string }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  session: {
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    hook(name: string, callback: (event: any) => void | Promise<void>): Promise<unknown>
    context(input: { sessionID: string }): Promise<readonly unknown[]>
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
  let emitStateChanged: (sessionID: string, state: string, consecutive: number) => Promise<void> = async () => {}
  const rpcContract = AUTOCONTINUE_RPC_CONTRACT

  const rpcImplementation = {
    async set(input: { sessionID: string; enabled: boolean }) {
      if (input.enabled) {
        await store.watch(input.sessionID, config().endTime ? computeEndAt(config().endTime, config().startTime) : 0)
      } else {
        await store.unwatch(input.sessionID)
      }
      const entry = store.getState(input.sessionID)
      const state = entry?.state ?? (input.enabled ? "watching" : "stopped")
      void emitStateChanged(input.sessionID, state, entry?.consecutive ?? 0)
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
    emitStateChanged = async (sessionID, state, consecutive) => {
      try {
        await rpcRegistration?.events.emit("state.changed", { sessionID, state, consecutive })
      } catch {
        // TUI may be disconnected; footer catches up on next status check.
      }
    }
  } catch (error) {
    console.error("[opencode-autocontinue] RPC registration failed (TUI status unavailable):", error)
  }

  const engine = new AutocontinueEngine(ctx.session, config, store, (sessionID, state, consecutive) => {
    void emitStateChanged(sessionID, state, consecutive)
  })
  await engine.installRetryHook()

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
