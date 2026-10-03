// Headless install verification for opencode-autocontinue server entry.
// Loads src/index.ts exactly as the opencode server would, drives setup()
// with a mock context, and exercises RPC + retry hook + cleanup.
import { setup } from "../src/index.ts"

const watched = new Map<string, Record<string, unknown>>()
const emittedEvents: Array<Record<string, unknown>> = []
let hookHandler: ((event: any) => void | Promise<void>) | undefined
let rpcImpl: any = undefined

const mockContext = {
  location: { directory: process.cwd() },
  storage: {
    async get(key: string) {
      return watched.get(key)
    },
    async set(key: string, value: unknown) {
      watched.set(key, value as Record<string, unknown>)
    },
  },
  session: {
    async prompt() {
      return {}
    },
    async hook(name: string, callback: (event: any) => void | Promise<void>) {
      if (name === "retry") hookHandler = callback
      return {}
    },
    async context() {
      return []
    },
  },
  event: {
    async *subscribe() {
      yield
    },
  },
  rpc: {
    async register(_contract: unknown, implementation: unknown) {
      rpcImpl = implementation
      return {
        events: {
          async emit(name: string, data: Record<string, unknown>) {
            emittedEvents.push({ name, ...data })
          },
        },
        async dispose() {},
      }
    },
  },
}

async function main() {
  const cleanup = await setup(mockContext as any)
  console.log("1. setup() returned cleanup fn:", typeof cleanup === "function")
  console.log("2. rpc impl registered:", typeof rpcImpl?.set === "function", typeof rpcImpl?.status === "function", typeof rpcImpl?.list === "function")

  // RPC set on -> watch
  const setResult = await rpcImpl.set({ sessionID: "ses_verify", enabled: true })
  console.log("3. rpc.set(on) state:", setResult.state)
  const statusOn = await rpcImpl.status({ sessionID: "ses_verify" })
  console.log("4. rpc.status watched:", statusOn.watched, "state:", statusOn.state?.state)

  // Retry hook registered + rewrites decision
  console.log("5. retry hook registered:", typeof hookHandler === "function")
  if (hookHandler) {
    const event = { error: { type: "AI_Error", message: "bad_response_status_code" }, attempt: 2, decision: { retry: false } }
    await hookHandler(event)
    console.log("6. retry hook rewrites retryable error:", event.decision.retry === true, "delay:", event.decision.delay)
  }

  // RPC set off -> unwatch
  await rpcImpl.set({ sessionID: "ses_verify", enabled: false })
  const statusOff = await rpcImpl.status({ sessionID: "ses_verify" })
  console.log("7. rpc.set(off) -> watched:", statusOff.watched)
  const listOff = await rpcImpl.list()
  console.log("8. rpc.list after off:", listOff.sessions.length === 0 ? "empty OK" : `has ${listOff.sessions.length}`)

  // Cleanup
  await cleanup()
  console.log("9. cleanup() OK; state.changed events emitted:", emittedEvents.length)

  const allOk =
    typeof cleanup === "function" &&
    setResult.state === "watching" &&
    statusOn.watched === true &&
    typeof hookHandler === "function" &&
    statusOff.watched === false &&
    listOff.sessions.length === 0
  console.log(allOk ? "\n=== HEADLESS INSTALL VERIFICATION PASSED ===" : "\n=== VERIFICATION FAILED ===")
  process.exit(allOk ? 0 : 1)
}

main().catch((error) => {
  console.error("verification threw:", error)
  process.exit(1)
})