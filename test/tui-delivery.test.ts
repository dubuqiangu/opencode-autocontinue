// v0.3.9 TUI delivery guards (oracle Experiment C, headless).
// The TUI render path ships as a prebuilt dist/tui.js bundle with all
// @opentui/* and solid-js external (host-provided at runtime). These static
// guards fail loudly if someone reintroduces a parasitic solid copy
// (solid-js/dist deep-path import), a peerDependencies shadow copy, a stale
// bundle, or an exports entry that bypasses the bundle.
// Run: node --experimental-strip-types --test test/tui-delivery.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
// The canonical stop-reason list lives in src/rpc.ts — the TUI label map is
// compared against it instead of a local copy, so a new reason cannot be
// added to the server without a matching TUI phrase.
import { STOP_REASONS } from "../src/rpc.ts"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

function readRepo(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8")
}

test("src imports bare solid-js (no solid-js/dist deep path)", () => {
  for (const sourceFile of ["src/tui.tsx", "src/reactive-mount.ts"]) {
    const source = readRepo(sourceFile)
    assert.ok(
      !source.includes("solid-js/dist"),
      `${sourceFile} must import bare "solid-js" (deep path resolves to a parasitic copy)`,
    )
  }
  // reactive-mount.ts imports only @opentui/solid (createElement/insert/setProp
  // — no signal primitives), so the bare-specifier requirement applies to the
  // files that actually touch solid-js reactivity.
  assert.ok(
    readRepo("src/tui.tsx").includes('from "solid-js"'),
    'src/tui.tsx must keep the bare solid-js specifier',
  )
})

test("dist/tui.js does not leak a deep-path solid import", () => {
  const bundle = readRepo("dist/tui.js")
  assert.ok(
    !bundle.includes("solid-js/dist"),
    'dist/tui.js must not contain "solid-js/dist" (would re-split the solid instance)',
  )
})

test("package.json removes peerDependencies (no shadow copies installed)", () => {
  const packageJson = JSON.parse(readRepo("package.json"))
  assert.ok(
    !packageJson.peerDependencies,
    "peerDependencies must be removed (@opentui/*, solid-js shadow copies split the instance)",
  )
})

test('exports["./tui"] points at the prebuilt bundle', () => {
  const packageJson = JSON.parse(readRepo("package.json"))
  assert.equal(packageJson.exports["./tui"], "./dist/tui.js")
})

test("dist/tui.js is committed and carries the collapsible header", () => {
  const bundlePath = join(repoRoot, "dist/tui.js")
  assert.ok(existsSync(bundlePath), "dist/tui.js must be committed (run npm run build:tui)")
  const bundle = readRepo("dist/tui.js")
  assert.ok(bundle.includes("isCollapsed"), "bundle must contain the v0.3.9 collapsible header signal")
  assert.ok(bundle.includes('from "solid-js"'), "bundle must keep bare solid-js external imports")
})

test("dist/tui.js is not a stale build (src marker is inside the bundle)", () => {
  // git does not preserve mtimes, so freshness is checked by content: the
  // current src/tui.tsx markers must appear in the bundle. If the bundle were
  // built from an older src, the fold signal name would be missing.
  const source = readRepo("src/tui.tsx")
  const bundle = readRepo("dist/tui.js")
  const foldMarker = "isCollapsed"
  assert.ok(source.includes(foldMarker), "precondition: src/tui.tsx defines the fold signal")
  assert.ok(
    bundle.includes(foldMarker),
    "dist/tui.js lacks the current src fold marker — stale bundle, run npm run build:tui",
  )
})

// v0.5.2 stop-reason delivery guards (architecture/provenance-and-loop.md
// §9.5 P3, TUI bullet). The stop reason is surfaced in exactly two places:
// the footer indicator and the /autocontinue status toast. The right sidebar
// keeps its existing contract — terminal states are NOT rendered there.

/**
 * src/tui.tsx is TSX and imports host-provided externals (@opencode/plugin/tui,
 * solid-js), so the test harness cannot import it directly (node's type
 * stripping rejects the .tsx extension). The stop-reason helpers are lifted
 * out of the source text and evaluated in isolation instead — the assertions
 * below therefore exercise the real mapping that ships in the bundle.
 */
function loadStopReasonHelpers(source: string): {
  labels: Record<string, string>
  label: (reason: string | undefined) => string | undefined
} {
  const start = source.indexOf("export const STOP_REASON_LABELS")
  const end = source.indexOf("export default Plugin.define(")
  assert.ok(start >= 0, "src/tui.tsx must define STOP_REASON_LABELS")
  assert.ok(end > start, "src/tui.tsx must define the stop-reason helpers above the plugin default export")
  const region = source
    .slice(start, end)
    .replace(/export /g, "")
    .replace(/: Record<string, string>/g, "")
    .replace(/: string \| undefined/g, "")
  const factory = new Function(`${region}\nreturn { STOP_REASON_LABELS, stopReasonLabel }`)
  const evaluated = factory() as {
    STOP_REASON_LABELS: Record<string, string>
    stopReasonLabel: (reason: string | undefined) => string | undefined
  }
  return { labels: evaluated.STOP_REASON_LABELS, label: evaluated.stopReasonLabel }
}

test("stopReasonLabel maps every known stop reason to a non-empty phrase", () => {
  const { labels, label } = loadStopReasonHelpers(readRepo("src/tui.tsx"))
  for (const reason of STOP_REASONS) {
    const phrase = label(reason)
    assert.ok(typeof phrase === "string" && phrase.length > 0, `${reason} must map to a non-empty phrase`)
    assert.equal(phrase, labels[reason], `${reason} must resolve to its mapped phrase`)
  }
  assert.equal(
    Object.keys(labels).length,
    STOP_REASONS.length,
    "the label map must cover exactly the eight stop reasons",
  )
})

test("the TUI label map covers exactly the stop reasons defined by src/rpc.ts", () => {
  const { labels } = loadStopReasonHelpers(readRepo("src/tui.tsx"))
  // No more, no less: a label without a reason is dead copy, a reason without
  // a label would render the bare footer without a phrase.
  assert.deepEqual(
    Object.keys(labels).sort(),
    [...STOP_REASONS].sort(),
    "the TUI label map keys must match STOP_REASONS exactly",
  )
  for (const reason of STOP_REASONS) {
    const phrase = labels[reason]
    assert.equal(typeof phrase, "string", `${reason} must have a label`)
    assert.ok(phrase.length > 0, `${reason} must have a non-empty phrase`)
  }
})

test("the title-excluded reason renders as the phrase 'title excluded'", () => {
  const { labels, label } = loadStopReasonHelpers(readRepo("src/tui.tsx"))
  assert.equal(labels["title-excluded"], "title excluded")
  assert.equal(label("title-excluded"), "title excluded")
})

test("stopReasonLabel returns undefined for an unknown or missing reason", () => {
  const { label } = loadStopReasonHelpers(readRepo("src/tui.tsx"))
  assert.equal(label(undefined), undefined, "a missing stop reason has no phrase")
  assert.equal(label("not-a-stop-reason"), undefined, "an unknown stop reason has no phrase")
})

test("footer indicator renders the stop reason phrase and omits it when absent", () => {
  const source = readRepo("src/tui.tsx")
  assert.ok(
    source.includes("[AC ⏹ ${status.injections} · ${phrase}]"),
    "the footer label must render [AC ⏹ N · phrase]",
  )
  assert.ok(
    source.includes("[AC ⏹ ${status.injections}]"),
    "the footer label must fall back to [AC ⏹ N] when there is no stop reason",
  )
})

test("the /autocontinue status toast includes the stop reason phrase", () => {
  const source = readRepo("src/tui.tsx")
  assert.ok(
    source.includes("stopReasonLabel(result.state.stopReason)"),
    "the status toast must resolve the stop reason phrase",
  )
  assert.ok(source.includes("` · ${stopPhrase}`"), "the status toast must append the stop reason phrase")
})

test("the sidebar block still renders no terminal state and no stop reason", () => {
  const source = readRepo("src/tui.tsx")
  const sidebarStart = source.indexOf("const SidebarStatus =")
  const sidebarEnd = source.indexOf("// Per-slot reactive mounts")
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart, "src/tui.tsx must define the SidebarStatus block")
  const sidebar = source.slice(sidebarStart, sidebarEnd)
  assert.ok(
    !sidebar.includes("stopReason"),
    "the sidebar block must not render the stop reason (footer + toast only)",
  )
  assert.ok(
    sidebar.includes('status.state !== "watching" && status.state !== "confirming"'),
    "the sidebar block must keep gating terminal states out",
  )
})

test("dist/tui.js carries the stop-reason handling", () => {
  const bundle = readRepo("dist/tui.js")
  assert.ok(bundle.includes("STOP_REASON_LABELS"), "the bundle must contain the stop-reason label map")
  assert.ok(bundle.includes("stopReasonLabel"), "the bundle must contain the stop-reason label helper")
  assert.ok(
    bundle.includes("stopReasonLabel(status.stopReason)"),
    "the bundle footer must resolve the stop reason phrase",
  )
  assert.ok(
    bundle.includes("stopReasonLabel(result.state.stopReason)"),
    "the bundle status toast must resolve the stop reason phrase",
  )
})

test("dist/tui.js is not a stale build (stop-reason helper is inside the bundle)", () => {
  const source = readRepo("src/tui.tsx")
  const bundle = readRepo("dist/tui.js")
  const stopReasonMarker = "STOP_REASON_LABELS"
  assert.ok(source.includes(stopReasonMarker), "precondition: src/tui.tsx defines the stop-reason label map")
  assert.ok(
    bundle.includes(stopReasonMarker),
    "dist/tui.js lacks the stop-reason helper — stale bundle, run npm run build:tui",
  )
})
