// RPC contract for opencode-autocontinue.
// Shared between server (implementer) and TUI (caller).
// Events let the TUI refresh its footer status live.

export const AUTOCONTINUE_RPC_ID = "autocontinue"

/**
 * Runtime RPC contract shared by server (ctx.rpc.register) and TUI
 * (context.client.rpc). The client derives callable methods from the
 * `methods` keys — an empty `methods` yields NO callable methods (rpc.set
 * would be undefined). Both sides MUST use this same contract.
 *
 * Note: this is a plain object (not `Rpc.define(...)` from @opencode/plugin/rpc)
 * so the server bundle (esbuild --platform=node, which cannot resolve the
 * host-provided @opencode/plugin/rpc) never imports it. Real-world plugins
 * pass Rpc.define(...) objects, but the client only needs the `methods` keys
 * to derive callables — verified against ensamber (rpc.teamContext),
 * oc-codex-multi-auth (rpc.status) and open-grok-build (rpc['accounts.list']).
 */
export const AUTOCONTINUE_RPC_CONTRACT = {
  id: AUTOCONTINUE_RPC_ID,
  methods: {
    set: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, enabled: { type: "boolean" } },
        required: ["sessionID", "enabled"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { state: { type: "string" } },
        required: ["state"],
        additionalProperties: false,
      },
    },
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { watched: { type: "boolean" }, state: { type: "object" } },
        required: ["watched"],
        additionalProperties: false,
      },
    },
    list: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { sessions: { type: "array" } },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
  },
  events: {
    "state.changed": {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          state: { type: "string" },
          consecutive: { type: "number" },
        },
        required: ["sessionID", "state", "consecutive"],
        additionalProperties: false,
      },
    },
  },
} as const

export interface WatchState {
  sessionID: string
  since: number
  consecutive: number
  lastInjectedAt?: number
  /** End of the current watch window (epoch ms). 0 = no window. Set at watch/resume time. */
  endAt?: number
  state: "watching" | "stopped" | "done"
}

export interface WatchStatus {
  sessionID: string
  state: WatchState["state"]
  consecutive: number
  lastInjectedAt?: number
  /** Epoch ms when watching started for this session (for the sidebar timer). */
  since: number
}

export interface RpcContract {
  methods: {
    set: {
      input: { sessionID: string; enabled: boolean }
      output: { state: WatchState["state"] }
    }
    status: {
      input: { sessionID: string }
      output: { watched: boolean; state?: WatchStatus }
    }
    list: {
      input: Record<string, never>
      output: { sessions: WatchStatus[] }
    }
  }
  events: {
    "state.changed": {
      schema: {
        type: "object"
        properties: {
          sessionID: { type: "string" }
          state: { type: "string" }
          consecutive: { type: "number" }
        }
        required: ["sessionID", "state", "consecutive"]
        additionalProperties: false
      }
    }
  }
}

// Minimal structural type so server/TUI agree without importing the runtime package.
export type AutocontinueRpc = {
  set(input: { sessionID: string; enabled: boolean }): Promise<{ state: string }>
  status(input: { sessionID: string }): Promise<{ watched: boolean; state?: WatchStatus }>
  list(): Promise<{ sessions: WatchStatus[] }>
}
