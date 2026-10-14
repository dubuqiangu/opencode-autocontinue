// Slot mounts following the OMO-Slim reactiveElement pattern (v0.3.9).
//
// Real-machine case history (pitfall #13, 2026-10-14..15):
// - v0.3.5 introduced a createRoot + swap-dispose mount. On the real host
//   the solid observer stack is per module instance: our signals/memos could
//   never register with the host's render effects, so the drawn tree froze at
//   the mount-time snapshot (sidebar "Watch" never appeared on /autocontinue
//   on|off). The createRoot also detached the mount from the host's
//   RendererContext ("No renderer found" pattern, same as usage-meter 0.7.22).
// - usage-meter v0.7.24/0.7.25 proved the fix: drop the peerDependencies
//   shadow copies so "solid-js" and "@opentui/solid" resolve to the host's
//   modules — the same graph the host slot machinery runs in, exactly like
//   OMO-Slim, which ships with no @opentui/solid-js deps at all and imports
//   bare specifiers.
//
// This module mirrors OMO-Slim's reactiveElement exactly: build a core box
// with createElement, insert the render fn at the slot-render ambient
// position. No createRoot — the insert's render effect lands in the same
// solid graph that is active during the slot render, where our
// signals/memos are first-class dependencies and the slot machinery's
// RendererContext provider is on the owner chain (that is why plain
// createElement works here and did not inside a detached root). Lifecycle:
// the host slot machinery re-evaluates the render on remounts and solid
// disposes the previous owned effect tree on computation re-runs — the
// same lifecycle OMO-Slim's sidebar lives by.
import { createElement, insert, setProp } from "@opentui/solid"

export type SlotMount = {
  root: any
  // Lifecycle is owned by the host slot machinery's computation tree (see
  // header) — nothing to dispose from our side; kept for API compatibility.
  dispose: () => void
}

function mountReactiveRoot(render: () => any, verticalLayout: boolean): SlotMount {
  const box = createElement("box")
  if (verticalLayout) {
    setProp(box, "width", "100%")
    setProp(box, "flexDirection", "column")
  }
  insert(box, render)
  return {
    root: box,
    dispose: () => {},
  }
}

// Per-slot mount lifecycle. Every host-driven slot re-render swaps in a
// fresh mount; the previous mount's effect tree is torn down by the host
// machinery re-evaluating the slot (solid disposes a computation's owned
// tree before re-running it).
export function createReactiveSlotMount(verticalLayout: boolean) {
  let current: SlotMount | undefined
  return {
    swap(render: () => any): any {
      current = mountReactiveRoot(render, verticalLayout)
      return current.root
    },
    release() {
      current = undefined
    },
  }
}