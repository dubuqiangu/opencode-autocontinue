/** @jsxImportSource @opentui/solid */
// OpenCode V2 TUI plugin "opencode-autocontinue" — slash command +
// footer status indicator + right-sidebar watch block.
//
// v0.2.0 reactivity / multi-session / i18n fix:
//   - per-session status store (Record<sessionID, WatchStatusView>) replaces
//     the single global watchStatus/watched signals — enabling session A no
//     longer overwrites session B's indicator (issue 4).
//   - all dynamic reads (status store, ticking clock) happen inside
//     createMemo so JSX re-renders on signal change — matches usage-meter
//     v0.7.8 ("the block looked frozen until the host re-mounted the sidebar;
//     all dynamic reads now live inside a createMemo"). Fixes the
//     "must switch session to see the block appear" symptom (issue 2).
//   - English-only labels (issue 1).
//   - slash `status` reads the RPC result directly (not a possibly-stale
//     signal); sessionID resolution prefers the slot-cached lastSlotSessionID
//     (authoritative) over the router during command execution (issue 3).
//
// Contract patterns verified against working V2 plugins on this runtime:
//   - current sessionID: slotProps.sessionID ?? router.params.sessionID
//   - keymap layer must be registered from an `app` slot render (direct
//     setup() call throws "Keymap.Provider is missing" on the host)
//   - toast / dialog access guarded via optional chaining
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { AUTOCONTINUE_RPC_CONTRACT } from "./rpc.ts"
// Session-ID resolution chain (JSX props-wrapper unwrap → slot cache →
// router), extracted as a pure module so the v0.3.6 "No current session"
// regression is unit-locked.
import { resolveSessionID } from "./session-resolution.ts"
// Pure TUI helpers (stop-reason labels, duration formatting, the
// `state.changed` merge rule) live in a JSX-free, solid-free module so the
// test suite can import them directly instead of scraping this file's text.
import { STOP_REASON_LABELS, formatDuration, mergeWatchState, stopReasonLabel, watchStateLabel } from "./tui-logic.ts"
import type { WatchStatusView } from "./tui-logic.ts"
// 0.3.5: slot mounts that create their render effects inside the plugin's own
// module graph (see reactive-mount.ts — pitfall #13 verdict, mirrors
// opencode-usage-meter v0.7.22).
import { createReactiveSlotMount } from "./reactive-mount.ts"

// The stop-reason helpers keep their historical export names on the plugin
// module; the implementation now lives in ./tui-logic.ts.
export { STOP_REASON_LABELS, stopReasonLabel }

const RPC_ID = "autocontinue"

type RpcClient = {
  set(input: { sessionID: string; enabled: boolean }): Promise<{ state: string }>
  status(input: { sessionID: string }): Promise<{ watched: boolean; state?: WatchStatusView }>
}

export default Plugin.define({
  id: "opencode-autocontinue-tui",
  setup(context: any) {
    // Per-session watch status store. A session is "watched" iff its entry is
    // defined. Populated by slash commands, RPC state.changed events,
    // focus-change refreshes, and each sidebar's mount fetch.
    const [statusStore, setStatusStore] = createSignal<Record<string, WatchStatusView | undefined>>({})
    const statusOf = (sessionID: string): WatchStatusView | undefined => statusStore()[sessionID]
    const updateStatus = (sessionID: string, status: WatchStatusView | undefined): void => {
      setStatusStore((prev) => {
        const current = prev[sessionID]
        if (current === status) return prev
        const next = { ...prev }
        if (status === undefined) delete next[sessionID]
        else next[sessionID] = status
        return next
      })
      try {
        context.renderer?.requestRender?.()
      } catch {
        // Request-render is best-effort; failure is silent.
      }
    }

    // The authoritative current-session source is the footer/app slot's
    // slotProps.sessionID (runtime-verified via usage-meter). The slash
    // command runs outside any slot render, so it can't read slotProps;
    // cache the last-seen sessionID here and have the command prefer it.
    let lastSlotSessionID: string | undefined

    // Sidebar Watch-block collapse state. Declared at setup scope (not inside
    // SidebarStatus) because the host re-mounts the sidebar slot often — a
    // per-mount createSignal would reset the fold on every re-mount, making
    // the header click appear dead. Same reason usage-meter persists its
    // statsBlockCollapsed flag in the settings store.
    const [isCollapsed, setIsCollapsed] = createSignal(false)

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
        if (result.watched) {
          // The server answered and still watches this session — its answer
          // is authoritative, so the local view is replaced with it.
          updateStatus(sessionID, result.state)
        } else {
          // The server answered "not watched" — only THEN may the local
          // entry go away.
          updateStatus(sessionID, undefined)
        }
      } catch {
        // The status query FAILED (host RPC not registered yet, or
        // temporarily unavailable). Keep the existing entry: the server may
        // still be injecting on schedule, and dropping the entry here makes
        // the footer "[AC ●]" and the sidebar Watch block disappear — a false
        // "the plugin stopped working" signal that invites the user to
        // re-run `/autocontinue on` (which resets the counters).
        // Nothing visible is added for this stale state: the rendered output
        // stays exactly as it is on the success path.
      }
    }

    async function setEnabled(sessionID: string, enabled: boolean): Promise<string> {
      const rpc = rpcClient()
      if (!rpc) throw new Error("autocontinue RPC unavailable")
      const result = await rpc.set({ sessionID, enabled })
      if (enabled) {
        updateStatus(sessionID, { sessionID, state: "watching", injections: 0, totalInjections: 0 })
        // Fetch the real WatchStatus (with since) so the sidebar timer starts
        // from the server-recorded start time, not the optimistic guess.
        void refreshStatus(sessionID)
      } else {
        updateStatus(sessionID, undefined)
      }
      return result.state
    }

    function currentSessionIDFrom(componentProps?: { slotProps?: any }): string | undefined {
      // Chain lives in session-resolution.ts (unit-locked): unwrap the JSX
      // props wrapper → slot-cached sessionID → router params. The router
      // may not reflect the focused session during slash-command execution,
      // so it stays the last resort.
      const routerSessionID = (context.ui as any)?.router?.current?.()?.params?.sessionID
      return resolveSessionID({ componentProps, cachedSessionID: lastSlotSessionID, routerSessionID })
    }

    const showToast = (title: string, message: string, variant?: string) => {
      try {
        ;(context.ui as any)?.toast?.show?.({ title, message, variant })
      } catch {
        // Toast surface unavailable — footer still shows the state.
      }
    }

    // Footer status indicator. The label memo returns null while the session
    // is unwatched; the tracked function child ({() => label()}) is wrapped in
    // a render effect by insertExpression, so the text patches in place the
    // moment the status flips — no <Show> gate, no host re-mount required
    // (same pattern as usage-meter's footer-status.tsx).
    const FooterIndicator = (componentProps: { slotProps?: any }) => {
      // componentProps is the JSX props wrapper ({slotProps: X}); the unwrap
      // lives in session-resolution.ts so the shape is unit-locked.
      const sessionID = currentSessionIDFrom(componentProps)
      if (sessionID) lastSlotSessionID = sessionID
      if (!sessionID) return null
      const label = createMemo(() => {
        const status = statusOf(sessionID)
        if (status === undefined) return null
        if (status.state === "done") return "[AC ✓]"
        if (status.state === "paused") return "[AC ⏸]"
        if (status.state === "stopped") {
          // The stop reason is shown here and in the /autocontinue status
          // toast only — the sidebar block never renders terminal states.
          const phrase = stopReasonLabel(status.stopReason)
          return phrase === undefined
            ? `[AC ⏹ ${status.injections}]`
            : `[AC ⏹ ${status.injections} · ${phrase}]`
        }
        return "[AC ●]"
      })
      return <text>{() => label()}</text>
    }

    // Right-sidebar status block, mirroring opencode-usage-meter's
    // sidebar-metrics slot. Renders from the shared per-session status store
    // through a memo (live timer + reactive updates), and hydrates the store
    // from the server on mount (throttled: the host may re-mount the sidebar
    // often). Always returns a container box; its tracked function-child gate
    // renders zero height while unwatched so it takes no visible space.
    const SidebarStatus = (props: { sessionID: string }) => {
      const [now, setNow] = createSignal(Date.now())
      let sidebarTimer: ReturnType<typeof setInterval> | undefined
      let lastFetchAt = 0

      // Hydrate this session's status from the server once per mount.
      createEffect(() => {
        const sessionID = props.sessionID
        if (!sessionID) return
        if (Date.now() - lastFetchAt > 2_000) {
          lastFetchAt = Date.now()
          void refreshStatus(sessionID)
        }
      })

      // Tick the elapsed watch timer while this session is actively being
      // watched OR confirming (the review round is still part of the watch
      // round); stops as soon as it leaves both.
      createEffect(() => {
        const status = statusOf(props.sessionID)
        const ticking = status?.state === "watching" || status?.state === "confirming"
        if (ticking && sidebarTimer === undefined) {
          sidebarTimer = setInterval(() => {
            setNow(Date.now())
            try {
              context.renderer?.requestRender?.()
            } catch {
              // Request-render is best-effort; failure is silent.
            }
          }, 1000)
        } else if (!ticking && sidebarTimer !== undefined) {
          clearInterval(sidebarTimer)
          sidebarTimer = undefined
        }
      })

      onCleanup(() => {
        if (sidebarTimer !== undefined) clearInterval(sidebarTimer)
      })

      const content = createMemo(() => {
        const status = statusOf(props.sessionID)
        if (status === undefined) return null
        // The sidebar block exists only while a watch round is ACTIVE
        // (watching/confirming). Terminal rows (done/stopped) are round-end
        // feedback and are carried by the footer indicator and the command
        // toast — rendering them here kept a permanent "Watch" block on
        // screen for every previously watched session.
        if (status.state !== "watching" && status.state !== "confirming") return null
        const metricLines: string[] = []
        // 状态由 🎯 文字行表达（watching/confirming/stopped/done），⏱ 只负责
        // 值守中的时长；stopped/done 不再重复符号（⏸/✓ 与 🎯 语义重复）。
        if (status.state === "watching" || status.state === "confirming") {
          metricLines.push(
            // The server has not reported the watch start time yet (the round
            // was just enabled and the real status has not arrived) — say the
            // clock is pending instead of showing an ellipsis that reads like
            // a truncated number next to the real counters.
            typeof status.since === "number" ? `⏱ ${formatDuration(now() - status.since)}` : "⏱ starting",
          )
        }
        // 注入次数用「累计」：每轮真实用户消息会把 injections 清零，单看它会
        // 误显示 0（让人以为插件没干活）。totalInjections 自本轮 watch 起累加，
        // 括号内是本轮（自上次用户消息）的注入数。
        const lifetime = typeof status.totalInjections === "number" ? status.totalInjections : status.injections
        const roundIn = status.injections
        const roundSuffix = typeof status.totalInjections === "number" && roundIn !== lifetime ? ` (${roundIn} this round)` : ""
        metricLines.push(`🔄 ${lifetime} injection${lifetime === 1 ? "" : "s"}${roundSuffix}`)
        // The raw protocol enum is never shown: it is an internal value, not a
        // label the user can read. The label map lives in ./tui-logic.ts so the
        // sidebar row and the status toast always name the same state the
        // same way.
        metricLines.push(`🎯 ${watchStateLabel(status.state)}`)
        if (status.verifying) metricLines.push("🔍 verifying")
        if (typeof status.rejections === "number" && status.rejections > 0) {
          metricLines.push(`🚫 ${status.rejections} rejection${status.rejections === 1 ? "" : "s"}`)
        }
        if (typeof status.toolFailureCount === "number" && status.toolFailureCount > 0) {
          metricLines.push(`🛠 ${status.toolFailureCount} tool failure${status.toolFailureCount === 1 ? "" : "s"}`)
        }
        return metricLines.join("\n")
      })

      // v0.3.8: NO <Show when={fn}> — Solid's Show never calls a function
      // `when` (it's truthy by identity), so the block rendered unconditionally
      // and the "Watch" title was always visible (the actual symptom-2 root
      // cause, oracle-verified against solid-js Show source).
      // v0.3.9: the container box stays mounted (zero height while gated —
      // invisible in the sidebar) and the inner tracked function child gates on
      // content(): insertExpression wraps each thunk in a render effect, so
      // null removes the subtree and non-null inserts it — on appears
      // immediately, off vanishes immediately, no host re-mount. The title row
      // is collapsible like usage-meter's Stats header: a click flips the
      // shared setup-scope collapsed signal (v0.3.10 — a per-mount signal
      // would be reset every host sidebar re-mount) and requests an immediate
      // repaint. All dynamic reads are function children ({() => ...}) — JSX
      // interpolations are evaluated once in the untracked component body and
      // would freeze.
      const muted = context.theme?.text?.muted
      return (
        <box flexDirection="column">
          {() =>
            content() !== null ? (
              <box flexDirection="column">
                <box
                  flexDirection="row"
                  width="100%"
                  onMouseUp={() => {
                    setIsCollapsed((prev) => !prev)
                    try {
                      context.renderer?.requestRender?.()
                    } catch {
                      // Repaint is best-effort; failure is silent.
                    }
                  }}
                >
                  <text fg={(context.theme as any)?.text?.base} selectable={false}>
                    {() => `${isCollapsed() ? "▸" : "▼"} Watch`}
                  </text>
                </box>
                {() =>
                  isCollapsed() ? null : <text fg={muted}>{() => content()}</text>
                }
              </box>
            ) : null
          }
        </box>
      )
    }

    // Per-slot reactive mounts (reactive-mount.ts). v0.3.9 follows the
    // OMO-Slim reactiveElement pattern: createElement + insert at the
    // slot-render ambient position, no createRoot — so render effects land in
    // the same solid graph the host slot machinery runs in (bare "solid-js"
    // specifier resolves to the host instance; no shadow copies). Footer is a
    // horizontal context — no layout props (verticalLayout=false).
    const footerMount = createReactiveSlotMount(false)

    let stopSlot: (() => void) | undefined
    try {
      const slotResult = context.ui.slot({
        append: "prompt.footer.status",
        render: (slotProps: any) => footerMount.swap(() => <FooterIndicator slotProps={slotProps} />),
      })
      if (typeof slotResult?.dispose === "function") stopSlot = slotResult.dispose
      else if (typeof slotResult === "function") stopSlot = slotResult as () => void
    } catch (error) {
      console.error("[opencode-autocontinue] footer slot failed:", error)
    }

    // Right-sidebar status block (mirrors opencode-usage-meter's
    // sidebar-metrics slot). The container box stays mounted while idle —
    // its tracked function-child gate renders an empty (zero-height) box so
    // the block occupies no visible space until watching starts. The sidebar
    // render is wrapped in a reactive mount (verticalLayout=true:
    // width="100%" column box) so the block updates live without a host
    // re-mount (pitfall #13, OMO-Slim pattern since v0.3.9).
    const sidebarMount = createReactiveSlotMount(true)
    let stopSidebarSlot: (() => void) | undefined
    try {
      const sidebarResult = context.ui.slot({
        append: "sidebar.content",
        render: (sidebarProps: any) =>
          sidebarProps?.sessionID
            ? sidebarMount.swap(() => <SidebarStatus sessionID={sidebarProps.sessionID} />)
            : null,
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
                    title: "Autocontinue: manage watch for current session",
                    group: "Autocontinue",
                    palette: true,
                    slash: { name: "autocontinue", aliases: ["ac"], arguments: true },
                    run: async (input: string) => {
                      const sessionID = currentSessionIDFrom()
                      if (!sessionID) {
                        showToast("Autocontinue", "No current session", "warning")
                        return
                      }
                      const args = (input ?? "").trim().split(/\s+/)[0]?.toLowerCase()
                      try {
                        if (args === "on") {
                          // The RPC answers with the protocol enum value;
                          // echoing it told the user nothing, so the toast
                          // states the outcome in plain words — mirroring
                          // "Watch disabled" on the way out.
                          await setEnabled(sessionID, true)
                          showToast("Autocontinue", "Watch enabled", "success")
                        } else if (args === "off") {
                          await setEnabled(sessionID, false)
                          showToast("Autocontinue", "Watch disabled", "success")
                        } else if (args === "status" || !args) {
                          const rpc = rpcClient()
                          if (!rpc) throw new Error("autocontinue RPC unavailable")
                          const result = await rpc.status({ sessionID })
                          if (result.watched && result.state) {
                            updateStatus(sessionID, result.state)
                            // A stopped round carries a short human-readable
                            // reason phrase (footer + toast are the only two
                            // surfaces that show it).
                            const stopPhrase =
                              result.state.state === "stopped"
                                ? stopReasonLabel(result.state.stopReason)
                                : undefined
                            const stopSuffix = stopPhrase === undefined ? "" : ` · ${stopPhrase}`
                            // The leading "Watching" segment is gone: it only
                            // repeated the state word. The state label itself
                            // now leads the line, so the toast and the sidebar
                            // 🎯 row name the same state the same way (same
                            // map, ./tui-logic.ts).
                            showToast(
                              "Autocontinue",
                              `${watchStateLabel(result.state.state)} · ${result.state.injections} injection${result.state.injections === 1 ? "" : "s"}${stopSuffix}`,
                              "info",
                            )
                          } else {
                            updateStatus(sessionID, undefined)
                            showToast("Autocontinue", "Not watching", "info")
                          }
                        } else {
                          showToast("Autocontinue", "Usage: /autocontinue on|off|status", "warning")
                        }
                      } catch (error) {
                        showToast(
                          "Autocontinue",
                          `Operation failed: ${String((error as Error)?.message ?? error)}`,
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
          const injections = event?.data?.injections ?? event?.properties?.injections ?? 0
          const totalInjections: number | undefined =
            event?.data?.totalInjections ?? event?.properties?.totalInjections
          const rejections: number | undefined = event?.data?.rejections ?? event?.properties?.rejections
          const verifying: boolean | undefined = event?.data?.verifying ?? event?.properties?.verifying
          const toolFailureCount: number | undefined =
            event?.data?.toolFailureCount ?? event?.properties?.toolFailureCount
          const stopReason: string | undefined = event?.data?.stopReason ?? event?.properties?.stopReason
          if (typeof sessionID !== "string") return
          // Per-session store: events for any watched session update only that
          // session's entry — no cross-session overwrite. The merge rule (and
          // the clearing of a stale stopReason) lives in ./tui-logic.ts.
          const merged = mergeWatchState(statusOf(sessionID), {
            sessionID,
            state: typeof state === "string" ? state : "",
            injections,
            totalInjections,
            rejections,
            verifying,
            toolFailureCount,
            stopReason,
          })
          if (merged !== undefined) updateStatus(sessionID, merged)
          if (state === "stopped") {
            // "stopped" 既可能是"被值守中因超限/到点停止"，也可能是"用户已 unwatch"。
            // 用 RPC status 复查区分：unwatch 后 status.watched=false → 清空本地信号。
            // A guardrail stop carries its reason in the event: the merge above
            // already put the phrase in the local view, so the footer can show
            // it without waiting for the RPC round-trip. A plain unwatch carries
            // no reason — nothing is merged, and the status re-check below
            // clears the local entry.
            void refreshStatus(sessionID)
          }
        })
        if (typeof unsubscribe === "function") stopEvents = unsubscribe
      }
    } catch (error) {
      console.error("[opencode-autocontinue] rpc event subscription failed:", error)
    }

    // Refresh the focused session's status when the focused session changes.
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
      // 0.3.5: dispose any live slot mount's reactive graph (idempotent when
      // the host already remounted past it).
      footerMount?.release?.()
      sidebarMount?.release?.()
    }

    onCleanup(disposeAll)

    return disposeAll
  },
})