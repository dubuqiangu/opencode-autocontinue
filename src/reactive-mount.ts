// Reactive slot mounts whose render effects live in the plugin's own module
// graph (0.3.5).
//
// Real-machine verdict (pitfall #13, same as opencode-usage-meter v0.7.22):
// when a slot render returns JSX whose function children are meant to become
// tracked thunks, it is the HOST that inserts those children — with its own
// @opentui/solid copy and its own solid-js instance. The render effects land
// in the host's module graph; our plugin-side signals/memos can never register
// with them (solid's observer stack is per module instance), so the drawn tree
// freezes at the mount-time snapshot while our memos recompute forever. That
// is exactly the v0.3.3/v0.3.4 symptom: the sidebar "Watch" block stays visible
// and `/autocontinue on|off` never refreshes until the host re-mounts the slot.
//
// The fix: before the element reaches the host, insert the render function
// into a plain core box OURSELVES (createElement + insert from @opentui/solid),
// inside a createRoot owned by the plugin. Every render effect then lives in
// the plugin's own module graph — the same graph as our signals and memos —
// so updates propagate normally, and the host only ever receives an ordinary
// core box.
import { createElement, insert, setProp } from "@opentui/solid"
import { createRoot } from "solid-js/dist/solid.js"

export type SlotMount = {
  root: any
  dispose: () => void
}

// Build a fresh reactive root around the given render: create the owner
// scope (so effects/memos clean up with the root), a core box, optionally
// the sidebar's vertical shape, then insert the render into the box.
function mountReactiveRoot(render: () => any, verticalLayout: boolean): SlotMount {
  let disposeOwner: (() => void) | undefined
  const root = createRoot((dispose) => {
    disposeOwner = dispose
    const box = createElement("box")
    if (verticalLayout) {
      setProp(box, "width", "100%")
      setProp(box, "flexDirection", "column")
    }
    insert(box, render)
    return box
  })
  return {
    root,
    dispose: () => {
      try {
        disposeOwner?.()
      } catch {
        // Dispose is best-effort; a host that already remounted past this
        // root makes it a no-op.
      }
    },
  }
}

// Per-slot mount lifecycle. Every host-driven slot re-render swaps in a fresh
// reactive root and disposes the previous root's reactive graph — the host
// re-renders the footer slot on nearly every input event, so without the swap
// each remount would leak a live effect chain writing into detached renderables.
export function createReactiveSlotMount(verticalLayout: boolean) {
  let current: SlotMount | undefined
  return {
    swap(render: () => any): any {
      current?.dispose()
      current = mountReactiveRoot(render, verticalLayout)
      return current.root
    },
    release() {
      current?.dispose()
      current = undefined
    },
  }
}