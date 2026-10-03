/** @jsxImportSource @opentui/solid */
// OpenCode V2 TUI plugin "opencode-autocontinue" — slash command +
// footer status indicator. Slash command and footer slot wrap the
// server-side RPC (autocontinue) for per-session watch toggling.
//
// Contract patterns verified against working V2 plugins on this runtime:
//   - current sessionID: slotProps.sessionID ?? router.params.sessionID
//   - keymap layer must be registered from an `app` slot render (direct
//     setup() call throws "Keymap.Provider is missing" on the host)
//   - toast / dialog access guarded via optional chaining
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

const RPC_ID = "autocontinue"

interface WatchStatusView {
  sessionID: string
  state: "watching" | "stopped" | "done"
  consecutive: number
  lastInjectedAt?: number
}

type RpcClient = {
  set(input: { sessionID: string; enabled: boolean }): Promise<{ state: string }>
  status(input: { sessionID: string }): Promise<{ watched: boolean; state?: WatchStatusView }>
}

export default Plugin.define({
  id: "opencode-autocontinue-tui",
  setup(context: any) {
    // Current watch status for the focused session, driven by RPC responses
    // and state.changed events. The footer slot component reads these, so
    // updates re-render the indicator reactively.
    const [watchStatus, setWatchStatus] = createSignal<WatchStatusView | undefined>(undefined)
    const [watched, setWatched] = createSignal(false)

    function rpcClient(): RpcClient | undefined {
      try {
        // client.rpc(contract) creates a subclient for the named RPC.
        return (context.client as any)?.rpc?.({ id: RPC_ID, methods: {} }) ?? undefined
      } catch {
        return undefined
      }
    }

    async function refreshStatus(sessionID: string): Promise<void> {
      const rpc = rpcClient()
      if (!rpc) return
      try {
        const result = await rpc.status({ sessionID })
        setWatched(result.watched)
        setWatchStatus(result.state)
      } catch {
        // RPC may not be registered yet; fall back to unknown.
        setWatched(false)
        setWatchStatus(undefined)
      }
    }

    async function setEnabled(sessionID: string, enabled: boolean): Promise<string> {
      const rpc = rpcClient()
      if (!rpc) throw new Error("autocontinue RPC 不可用")
      const result = await rpc.set({ sessionID, enabled })
      setWatched(enabled)
      if (!enabled) setWatchStatus(undefined)
      else {
        setWatchStatus({ sessionID, state: "watching", consecutive: 0 })
      }
      return result.state
    }

    function currentSessionIDFrom(slotProps?: any): string | undefined {
      return (
        slotProps?.sessionID ??
        (context.ui as any)?.router?.current?.()?.params?.sessionID ??
        undefined
      )
    }

    const showToast = (title: string, message: string, variant?: string) => {
      try {
        ;(context.ui as any)?.toast?.show?.({ title, message, variant })
      } catch {
        // Toast surface unavailable — footer still shows the state.
      }
    }

    // Footer status indicator. Rendered as a component reading the signals
    // so the label updates reactively when the RPC state changes.
    const FooterIndicator = (slotProps?: any) => {
      const sessionID = currentSessionIDFrom(slotProps)
      if (!sessionID) return null
      const status = watchStatus()
      if (!watched() && status === undefined) return null
      const label =
        status === undefined
          ? "[AC ?]"
          : status.state === "done"
            ? "[AC ✓]"
            : status.state === "stopped"
              ? `[AC ⏸ ${status.consecutive}]`
              : "[AC ●]"
      return <text>{label}</text>
    }

    let stopSlot: (() => void) | undefined
    try {
      const slotResult = context.ui.slot({
        append: "prompt.footer.status",
        render: FooterIndicator,
      })
      if (typeof slotResult?.dispose === "function") stopSlot = slotResult.dispose
      else if (typeof slotResult === "function") stopSlot = slotResult as () => void
    } catch (error) {
      console.error("[opencode-autocontinue] footer slot failed:", error)
    }

    // Slash command /autocontinue on|off|status. Registered from an `app`
    // slot render (verified runtime pattern) so the keymap provider exists.
    let layerDispose: (() => void) | undefined
    let stopAppSlot: (() => void) | undefined
    try {
      stopAppSlot = context.ui.slot({
        append: "app",
        render: () => {
          if (layerDispose === undefined) {
            try {
              const layer = (context.keymap as any)?.layer?.(() => ({
                mode: "global",
                commands: [
                  {
                    id: "opencode-autocontinue.toggle",
                    title: "Autocontinue: 管理当前会话值守",
                    group: "Autocontinue",
                    palette: true,
                    slash: { name: "autocontinue", aliases: ["ac"], arguments: true },
                    run: async (input: string) => {
                      const sessionID = currentSessionIDFrom()
                      if (!sessionID) {
                        showToast("Autocontinue", "没有当前会话", "warning")
                        return
                      }
                      const args = (input ?? "").trim().split(/\s+/)[0]?.toLowerCase()
                      try {
                        if (args === "on") {
                          const state = await setEnabled(sessionID, true)
                          showToast("Autocontinue", `值守已开启 (${state})`, "success")
                        } else if (args === "off") {
                          await setEnabled(sessionID, false)
                          showToast("Autocontinue", "值守已关闭", "success")
                        } else if (args === "status" || !args) {
                          await refreshStatus(sessionID)
                          const status = watchStatus()
                          const message = status
                            ? `值守中 · ${status.state} · 已续跑 ${status.consecutive} 次`
                            : "未值守"
                          showToast("Autocontinue", message, "info")
                        } else {
                          showToast("Autocontinue", "用法: /autocontinue on|off|status", "warning")
                        }
                      } catch (error) {
                        showToast(
                          "Autocontinue",
                          `操作失败: ${String((error as Error)?.message ?? error)}`,
                          "error",
                        )
                      }
                    },
                  },
                ],
              }))
              if (typeof layer?.dispose === "function") layerDispose = layer.dispose
              else if (typeof layer === "function") layerDispose = layer as () => void
              else layerDispose = undefined
            } catch (error) {
              layerDispose = undefined
              console.error("[opencode-autocontinue] keymap layer failed:", error)
            }
          }
          return null
        },
      })
      if (typeof stopAppSlot?.dispose === "function") stopAppSlot = stopAppSlot.dispose
      else if (typeof stopAppSlot === "function") stopAppSlot = stopAppSlot as () => void
    } catch (error) {
      console.error("[opencode-autocontinue] app slot failed:", error)
    }

    // Best-effort RPC state.changed subscription (may not fire on all hosts;
    // footer also refreshes on command and focus changes).
    let stopEvents: (() => void) | undefined
    try {
      const events = context.data
      if (events && typeof events.on === "function") {
        const unsubscribe = events.on(`rpc.${RPC_ID}.state.changed`, (event: any) => {
          const sessionID = event?.data?.sessionID ?? event?.properties?.sessionID ?? event?.sessionID
          const state = event?.data?.state ?? event?.properties?.state
          const consecutive = event?.data?.consecutive ?? event?.properties?.consecutive ?? 0
          if (typeof sessionID === "string") {
            setWatched(true)
            setWatchStatus({ sessionID, state, consecutive })
          }
        })
        if (typeof unsubscribe === "function") stopEvents = unsubscribe
      }
    } catch (error) {
      console.error("[opencode-autocontinue] rpc event subscription failed:", error)
    }

    // Refresh footer when the focused session changes.
    let stopFocusRefresh: (() => void) | undefined
    try {
      const router = (context.ui as any)?.router
      const unsubscribe = router?.current?.subscribe?.(() => {
        const sessionID = currentSessionIDFrom()
        if (sessionID) void refreshStatus(sessionID)
      })
      if (typeof unsubscribe === "function") stopFocusRefresh = unsubscribe
    } catch {
      // Fall through.
    }

    onCleanup(() => {
      stopEvents?.()
      stopSlot?.()
      stopAppSlot?.()
      layerDispose?.()
      stopFocusRefresh?.()
    })

    return () => {
      stopEvents?.()
      stopSlot?.()
      stopAppSlot?.()
      layerDispose?.()
      stopFocusRefresh?.()
    }
  },
})