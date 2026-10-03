// RPC contract for opencode-autocontinue.
// Shared between server (implementer) and TUI (caller).
// Events let the TUI refresh its footer status live.

export const AUTOCONTINUE_RPC_ID = "autocontinue"

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
