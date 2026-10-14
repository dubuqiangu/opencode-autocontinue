// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

// src/rpc.ts
var AUTOCONTINUE_RPC_ID = "autocontinue";
var AUTOCONTINUE_RPC_CONTRACT = {
  id: AUTOCONTINUE_RPC_ID,
  methods: {
    set: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, enabled: { type: "boolean" } },
        required: ["sessionID", "enabled"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { state: { type: "string" } },
        required: ["state"],
        additionalProperties: false
      }
    },
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          watched: { type: "boolean" },
          state: {
            type: "object",
            properties: {
              sessionID: { type: "string" },
              state: { type: "string" },
              injections: { type: "number" },
              lastInjectedAt: { type: "number" },
              since: { type: "number" }
            },
            required: ["sessionID", "state", "injections", "since"],
            additionalProperties: false
          }
        },
        required: ["watched"],
        additionalProperties: false
      }
    },
    list: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { sessions: { type: "array" } },
        required: ["sessions"],
        additionalProperties: false
      }
    }
  },
  events: {
    "state.changed": {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          state: { type: "string" },
          injections: { type: "number" }
        },
        required: ["sessionID", "state", "injections"],
        additionalProperties: false
      }
    }
  }
};

// src/session-resolution.ts
function slotSessionIDFrom(componentProps) {
  const sessionID = componentProps?.slotProps?.sessionID;
  return typeof sessionID === "string" && sessionID ? sessionID : void 0;
}
function nonEmptyString(value) {
  return typeof value === "string" && value ? value : void 0;
}
function resolveSessionID(sources) {
  return slotSessionIDFrom(sources.componentProps) ?? nonEmptyString(sources.cachedSessionID) ?? nonEmptyString(sources.routerSessionID) ?? void 0;
}

// src/reactive-mount.ts
import { createElement, insert, setProp } from "@opentui/solid";
function mountReactiveRoot(render, verticalLayout) {
  const box = createElement("box");
  if (verticalLayout) {
    setProp(box, "width", "100%");
    setProp(box, "flexDirection", "column");
  }
  insert(box, render);
  return {
    root: box,
    dispose: () => {
    }
  };
}
function createReactiveSlotMount(verticalLayout) {
  let current;
  return {
    swap(render) {
      current = mountReactiveRoot(render, verticalLayout);
      return current.root;
    },
    release() {
      current = void 0;
    }
  };
}

// src/tui.tsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var RPC_ID = "autocontinue";
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1e3);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds % 86400 / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
var tui_default = Plugin.define({
  id: "opencode-autocontinue-tui",
  setup(context) {
    const [statusStore, setStatusStore] = createSignal({});
    const statusOf = (sessionID) => statusStore()[sessionID];
    const updateStatus = (sessionID, status) => {
      setStatusStore((prev) => {
        const current = prev[sessionID];
        if (current === status) return prev;
        const next = { ...prev };
        if (status === void 0) delete next[sessionID];
        else next[sessionID] = status;
        return next;
      });
      try {
        context.renderer?.requestRender?.();
      } catch {
      }
    };
    let lastSlotSessionID;
    let cachedRpcClient;
    function rpcClient() {
      if (cachedRpcClient !== void 0) return cachedRpcClient;
      try {
        cachedRpcClient = context.client?.rpc?.(AUTOCONTINUE_RPC_CONTRACT) ?? void 0;
        return cachedRpcClient;
      } catch {
        return void 0;
      }
    }
    async function refreshStatus(sessionID) {
      const rpc = rpcClient();
      if (!rpc) return;
      try {
        const result = await rpc.status({ sessionID });
        updateStatus(sessionID, result.state);
      } catch {
        updateStatus(sessionID, void 0);
      }
    }
    async function setEnabled(sessionID, enabled) {
      const rpc = rpcClient();
      if (!rpc) throw new Error("autocontinue RPC unavailable");
      const result = await rpc.set({ sessionID, enabled });
      if (enabled) {
        updateStatus(sessionID, { sessionID, state: "watching", injections: 0 });
        void refreshStatus(sessionID);
      } else {
        updateStatus(sessionID, void 0);
      }
      return result.state;
    }
    function currentSessionIDFrom(componentProps) {
      const routerSessionID = context.ui?.router?.current?.()?.params?.sessionID;
      return resolveSessionID({ componentProps, cachedSessionID: lastSlotSessionID, routerSessionID });
    }
    const showToast = (title, message, variant) => {
      try {
        ;
        context.ui?.toast?.show?.({ title, message, variant });
      } catch {
      }
    };
    const FooterIndicator = (componentProps) => {
      const sessionID = currentSessionIDFrom(componentProps);
      if (sessionID) lastSlotSessionID = sessionID;
      if (!sessionID) return null;
      const label = createMemo(() => {
        const status = statusOf(sessionID);
        if (status === void 0) return null;
        if (status.state === "done") return "[AC \u2713]";
        if (status.state === "stopped") return `[AC \u23F8 ${status.injections}]`;
        return "[AC \u25CF]";
      });
      return /* @__PURE__ */ jsx("text", { children: () => label() });
    };
    const SidebarStatus = (props) => {
      const [now, setNow] = createSignal(Date.now());
      let sidebarTimer;
      let lastFetchAt = 0;
      createEffect(() => {
        const sessionID = props.sessionID;
        if (!sessionID) return;
        if (Date.now() - lastFetchAt > 2e3) {
          lastFetchAt = Date.now();
          void refreshStatus(sessionID);
        }
      });
      createEffect(() => {
        const status = statusOf(props.sessionID);
        const ticking = status?.state === "watching" || status?.state === "confirming";
        if (ticking && sidebarTimer === void 0) {
          sidebarTimer = setInterval(() => {
            setNow(Date.now());
            try {
              context.renderer?.requestRender?.();
            } catch {
            }
          }, 1e3);
        } else if (!ticking && sidebarTimer !== void 0) {
          clearInterval(sidebarTimer);
          sidebarTimer = void 0;
        }
      });
      onCleanup(() => {
        if (sidebarTimer !== void 0) clearInterval(sidebarTimer);
      });
      const content = createMemo(() => {
        const status = statusOf(props.sessionID);
        if (status === void 0) return null;
        if (status.state !== "watching" && status.state !== "confirming") return null;
        const metricLines = [];
        if (status.state === "watching" || status.state === "confirming") {
          metricLines.push(
            typeof status.since === "number" ? `\u23F1 ${formatDuration(now() - status.since)}` : "\u23F1 \u2026"
          );
        }
        metricLines.push(`\u{1F504} ${status.injections} injection${status.injections === 1 ? "" : "s"}`);
        metricLines.push(`\u{1F3AF} ${status.state}`);
        return metricLines.join("\n");
      });
      const [isCollapsed, setIsCollapsed] = createSignal(false);
      const muted = context.theme?.text?.muted;
      return /* @__PURE__ */ jsx("box", { flexDirection: "column", children: () => content() !== null ? /* @__PURE__ */ jsxs("box", { flexDirection: "column", children: [
        /* @__PURE__ */ jsx(
          "box",
          {
            flexDirection: "row",
            width: "100%",
            onMouseUp: () => {
              setIsCollapsed((prev) => !prev);
              try {
                context.renderer?.requestRender?.();
              } catch {
              }
            },
            children: /* @__PURE__ */ jsx("text", { fg: context.theme?.text?.base, selectable: false, children: () => `${isCollapsed() ? "\u25B8" : "\u25BC"} Watch` })
          }
        ),
        () => isCollapsed() ? null : /* @__PURE__ */ jsx("text", { fg: muted, children: () => content() })
      ] }) : null });
    };
    const footerMount = createReactiveSlotMount(false);
    let stopSlot;
    try {
      const slotResult = context.ui.slot({
        append: "prompt.footer.status",
        render: (slotProps) => footerMount.swap(() => /* @__PURE__ */ jsx(FooterIndicator, { slotProps }))
      });
      if (typeof slotResult?.dispose === "function") stopSlot = slotResult.dispose;
      else if (typeof slotResult === "function") stopSlot = slotResult;
    } catch (error) {
      console.error("[opencode-autocontinue] footer slot failed:", error);
    }
    const sidebarMount = createReactiveSlotMount(true);
    let stopSidebarSlot;
    try {
      const sidebarResult = context.ui.slot({
        append: "sidebar.content",
        render: (sidebarProps) => sidebarProps?.sessionID ? sidebarMount.swap(() => /* @__PURE__ */ jsx(SidebarStatus, { sessionID: sidebarProps.sessionID })) : null
      });
      if (typeof sidebarResult?.dispose === "function") stopSidebarSlot = sidebarResult.dispose;
      else if (typeof sidebarResult === "function") stopSidebarSlot = sidebarResult;
    } catch (error) {
      console.error("[opencode-autocontinue] sidebar slot failed:", error);
    }
    let layerDispose;
    let stopAppSlot;
    try {
      stopAppSlot = context.ui.slot({
        append: "app",
        render: () => {
          if (layerDispose === void 0) {
            try {
              const layer = context.keymap?.layer?.(() => ({
                mode: "global",
                commands: [
                  {
                    id: "opencode-autocontinue.toggle",
                    title: "Autocontinue: manage watch for current session",
                    group: "Autocontinue",
                    palette: true,
                    slash: { name: "autocontinue", aliases: ["ac"], arguments: true },
                    run: async (input) => {
                      const sessionID = currentSessionIDFrom();
                      if (!sessionID) {
                        showToast("Autocontinue", "No current session", "warning");
                        return;
                      }
                      const args = (input ?? "").trim().split(/\s+/)[0]?.toLowerCase();
                      try {
                        if (args === "on") {
                          const state = await setEnabled(sessionID, true);
                          showToast("Autocontinue", `Watch enabled (${state})`, "success");
                        } else if (args === "off") {
                          await setEnabled(sessionID, false);
                          showToast("Autocontinue", "Watch disabled", "success");
                        } else if (args === "status" || !args) {
                          const rpc = rpcClient();
                          if (!rpc) throw new Error("autocontinue RPC unavailable");
                          const result = await rpc.status({ sessionID });
                          if (result.watched && result.state) {
                            updateStatus(sessionID, result.state);
                            showToast(
                              "Autocontinue",
                              `Watching \xB7 ${result.state.state} \xB7 ${result.state.injections} injection${result.state.injections === 1 ? "" : "s"}`,
                              "info"
                            );
                          } else {
                            updateStatus(sessionID, void 0);
                            showToast("Autocontinue", "Not watching", "info");
                          }
                        } else {
                          showToast("Autocontinue", "Usage: /autocontinue on|off|status", "warning");
                        }
                      } catch (error) {
                        showToast(
                          "Autocontinue",
                          `Operation failed: ${String(error?.message ?? error)}`,
                          "error"
                        );
                      }
                    }
                  }
                ]
              }));
              if (typeof layer?.dispose === "function") layerDispose = layer.dispose;
              else if (typeof layer === "function") layerDispose = layer;
              else layerDispose = void 0;
            } catch (error) {
              layerDispose = void 0;
              console.error("[opencode-autocontinue] keymap layer failed:", error);
            }
          }
          return null;
        }
      });
      if (typeof stopAppSlot?.dispose === "function") stopAppSlot = stopAppSlot.dispose;
      else if (typeof stopAppSlot === "function") stopAppSlot = stopAppSlot;
    } catch (error) {
      console.error("[opencode-autocontinue] app slot failed:", error);
    }
    let stopEvents;
    try {
      const events = context.data;
      if (events && typeof events.on === "function") {
        const unsubscribe = events.on(`rpc.${RPC_ID}.state.changed`, (event) => {
          const sessionID = event?.data?.sessionID ?? event?.properties?.sessionID ?? event?.sessionID;
          const state = event?.data?.state ?? event?.properties?.state;
          const injections = event?.data?.injections ?? event?.properties?.injections ?? 0;
          if (typeof sessionID !== "string") return;
          if (state === "stopped") {
            void refreshStatus(sessionID);
          } else if (state === "watching" || state === "confirming" || state === "done") {
            const current = statusOf(sessionID);
            updateStatus(sessionID, { ...current ?? {}, sessionID, state, injections });
          }
        });
        if (typeof unsubscribe === "function") stopEvents = unsubscribe;
      }
    } catch (error) {
      console.error("[opencode-autocontinue] rpc event subscription failed:", error);
    }
    let stopFocusRefresh;
    try {
      const router = context.ui?.router;
      const unsubscribe = router?.current?.subscribe?.(() => {
        const sessionID = currentSessionIDFrom();
        if (sessionID) void refreshStatus(sessionID);
      });
      if (typeof unsubscribe === "function") stopFocusRefresh = unsubscribe;
    } catch {
    }
    let disposed = false;
    function disposeAll() {
      if (disposed) return;
      disposed = true;
      stopEvents?.();
      stopSlot?.();
      stopSidebarSlot?.();
      stopAppSlot?.();
      layerDispose?.();
      stopFocusRefresh?.();
      footerMount?.release?.();
      sidebarMount?.release?.();
    }
    onCleanup(disposeAll);
    return disposeAll;
  }
});
export {
  tui_default as default
};
