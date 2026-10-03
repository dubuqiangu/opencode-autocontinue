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
import { createEffect, createSignal, onCleanup } from "solid-js"
import { AUTOCONTINUE_RPC_CONTRACT } from "./rpc.ts"

const RPC_ID = "autocontinue"

interface WatchStatusView {
  sessionID: string
  state: "watching" | "stopped" | "done"
  consecutive: number
  lastInjectedAt?: number
  /** Epoch ms when watching started for this session (drives the sidebar timer). */
  since?: number
}

type RpcClient = {
  set(input: { sessionID: string; enabled: boolean }): Promise<{ state: string }>
  status(input: { sessionID: string }): Promise<{ watched: boolean; state?: WatchStatusView }>
}

// "3m 22s" (≥1 min) or "45s". Clamps negative/NaN inputs to "0s".
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export default Plugin.define({
  id: "opencode-autocontinue-tui",
  setup(context: any) {
    // Current watch status for the focused session, driven by RPC responses
    // and state.changed events. The footer slot component reads these, so
    // updates re-render the indicator reactively.
    const [watchStatus, setWatchStatus] = createSignal<WatchStatusView | undefined>(undefined)
    const [watched, setWatched] = createSignal(false)

    // The authoritative current-session source is the footer/app slot's
    // slotProps.sessionID (runtime-verified via usage-meter). The slash
    // command runs outside any slot render, so it can't read slotProps;
    // cache the last-seen sessionID here and have the command prefer it.
    let lastSlotSessionID: string | undefined

    // Reuse a single RPC subclient for the plugin lifetime (avoid leaking a
    // subclient per call).
    let cachedRpcClient: RpcClient | undefined
    function rpcClient(): RpcClient | undefined {
      if (cachedRpcClient !== undefined) return cachedRpcClient
      try {
        // client.rpc(contract) creates a subclient for the named RPC. The
        // contract's `methods` keys become the callable methods — an empty
        // methods object yields NO callable methods (rpc.set would be
        // undefined). Always pass the full shared contract.
        cachedRpcClient = (context.client as any)?.rpc?.(AUTOCONTINUE_RPC_CONTRACT) ?? undefined
        return cachedRpcClient
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
      const routerSessionID = (context.ui as any)?.router?.current?.()?.params?.sessionID
      return (
        slotProps?.sessionID ??
        (typeof routerSessionID === "string" && routerSessionID ? routerSessionID : undefined) ??
        lastSlotSessionID ??
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
      if (sessionID) lastSlotSessionID = sessionID
      if (!sessionID) return null
      const status = watchStatus()
      // The global watch signal may describe a different session (another
      // session's events/refresh landed first). Only render the indicator
      // when the status belongs to the session this footer is rendering for.
      if (status !== undefined && status.sessionID !== sessionID) return null
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

    // Right-sidebar status block, mirroring opencode-usage-meter's
    // sidebar-metrics slot. Fetches fresh per-session state over RPC into a
    // local signal (reusing the shared rpcClient) and renders three metric
    // lines; returns null while the session is not watched so it takes no
    // space in the sidebar.
    const SidebarStatus = (props: { sessionID: string }) => {
      const [sidebarState, setSidebarState] = createSignal<WatchStatusView | undefined>(undefined)
      const [now, setNow] = createSignal(Date.now())
      let sidebarTimer: ReturnType<typeof setInterval> | undefined

      async function refreshSidebarStatus(sessionID: string): Promise<void> {
        const rpc = rpcClient()
        if (!rpc) return
        try {
          const result = await rpc.status({ sessionID })
          if (sessionID === props.sessionID) setSidebarState(result.state)
        } catch {
          if (sessionID === props.sessionID) setSidebarState(undefined)
        }
      }

      // Refetch on session change, and whenever the watch flag/status flips
      // (toggle on/off, state.changed events). Clears stale local state when
      // the session is not watched anymore.
      createEffect(() => {
        const sessionID = props.sessionID
        if (!sessionID) return
        if (watched() || watchStatus() !== undefined) {
          void refreshSidebarStatus(sessionID)
        } else {
          setSidebarState(undefined)
        }
      })

      // Tick the elapsed watch timer only while this session is actively
      // being watched; stops as soon as it leaves `watching`.
      createEffect(() => {
        const sessionStatus =
          sidebarState()?.sessionID === props.sessionID
            ? sidebarState()
            : watchStatus()?.sessionID === props.sessionID
              ? watchStatus()
              : undefined
        const ticking = watched() && sessionStatus?.state === "watching"
        if (ticking && sidebarTimer === undefined) {
          sidebarTimer = setInterval(() => setNow(Date.now()), 1000)
        } else if (!ticking && sidebarTimer !== undefined) {
          clearInterval(sidebarTimer)
          sidebarTimer = undefined
        }
      })

      onCleanup(() => {
        if (sidebarTimer !== undefined) clearInterval(sidebarTimer)
      })

      if (!props.sessionID) return null
      const globalStatus = watchStatus()?.sessionID === props.sessionID ? watchStatus() : undefined
      const localStatus = sidebarState()?.sessionID === props.sessionID ? sidebarState() : undefined
      const status = localStatus ?? globalStatus
      if (!watched() && globalStatus === undefined && localStatus === undefined) return null
      if (!status) return null

      const metricLines: string[] = []
      if (status.state === "watching") {
        metricLines.push(
          typeof status.since === "number" ? `⏱ ${formatDuration(now() - status.since)}` : "⏱ …",
        )
      } else if (status.state === "stopped") {
        metricLines.push("⏱ ⏸")
      } else {
        metricLines.push("⏱ ✓")
      }
      metricLines.push(`🔁 ${status.consecutive} 次续跑`)
      metricLines.push(`🎯 ${status.state}`)

      const muted = context.theme?.text?.muted
      return (
        <box flexDirection="column">
          <text fg={(context.theme as any)?.text?.base}>值守</text>
          <text fg={muted}>{metricLines.join("\n")}</text>
        </box>
      )
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

    // Right-sidebar status block (mirrors opencode-usage-meter's
    // sidebar-metrics slot). SidebarStatus returns null when the session is
    // not watched, so the block occupies no space while idle.
    let stopSidebarSlot: (() => void) | undefined
    try {
      const sidebarResult = context.ui.slot({
        append: "sidebar.content",
        render: (sidebarProps: any) =>
          sidebarProps?.sessionID ? (
            <SidebarStatus sessionID={sidebarProps.sessionID} />
          ) : null,
      })
      if (typeof sidebarResult?.dispose === "function") stopSidebarSlot = sidebarResult.dispose
      else if (typeof sidebarResult === "function") stopSidebarSlot = sidebarResult as () => void
    } catch (error) {
      console.error("[opencode-autocontinue] sidebar slot failed:", error)
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
          if (typeof sessionID !== "string") return
          const current = currentSessionIDFrom()
          if (state === "stopped") {
            // "stopped" 既可能是"被值守中因超限/到点停止"，也可能是"用户已 unwatch"。
            // 用 RPC status 复查区分：unwatch 后 status.watched=false → 清空本地信号。
            void refreshStatus(sessionID)
          } else {
            // watching / done：只更新信号；非当前焦点会话的事件不写全局信号。
            if (sessionID !== current) return
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

    // Dispose every registered resource exactly once, whether the host calls
    // the setup() return value or Solid's onCleanup runs first.
    let disposed = false
    function disposeAll(): void {
      if (disposed) return
      disposed = true
      stopEvents?.()
      stopSlot?.()
      stopSidebarSlot?.()
      stopAppSlot?.()
      layerDispose?.()
      stopFocusRefresh?.()
    }

    onCleanup(disposeAll)

    return disposeAll
  },
})