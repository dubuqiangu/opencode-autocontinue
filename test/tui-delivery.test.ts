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
// The stop-reason label map, the duration formatter and the `state.changed`
// merge rule live in src/tui-logic.ts (a pure .ts module with no JSX and no
// solid-js import), so the test suite imports them directly instead of
// scraping the .tsx source text.
import {
  STOP_REASON_LABELS,
  stopReasonLabel,
  WATCH_STATE_LABELS,
  watchStateLabel,
  formatDuration,
  mergeWatchState,
} from "../src/tui-logic.ts"
import type { WatchStatusView, WatchStateChanged } from "../src/tui-logic.ts"

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
 * stripping rejects the .tsx extension). The pure helpers it depends on were
 * extracted into src/tui-logic.ts, which the test imports directly — the
 * assertions below therefore exercise the real mapping that ships in the
 * bundle.
 */
test("stopReasonLabel maps every known stop reason to a non-empty phrase", () => {
  for (const reason of STOP_REASONS) {
    const phrase = stopReasonLabel(reason)
    assert.ok(typeof phrase === "string" && phrase.length > 0, `${reason} must map to a non-empty phrase`)
    assert.equal(phrase, STOP_REASON_LABELS[reason], `${reason} must resolve to its mapped phrase`)
  }
  assert.equal(
    Object.keys(STOP_REASON_LABELS).length,
    STOP_REASONS.length,
    "the label map must cover exactly the eight stop reasons",
  )
})

test("the TUI label map covers exactly the stop reasons defined by src/rpc.ts", () => {
  // No more, no less: a label without a reason is dead copy, a reason without
  // a label would render the bare footer without a phrase.
  assert.deepEqual(
    Object.keys(STOP_REASON_LABELS).sort(),
    [...STOP_REASONS].sort(),
    "the TUI label map keys must match STOP_REASONS exactly",
  )
  for (const reason of STOP_REASONS) {
    const phrase = STOP_REASON_LABELS[reason]
    assert.equal(typeof phrase, "string", `${reason} must have a label`)
    assert.ok(phrase.length > 0, `${reason} must have a non-empty phrase`)
  }
})

test("the title-excluded reason renders as the phrase 'title excluded'", () => {
  assert.equal(STOP_REASON_LABELS["title-excluded"], "title excluded")
  assert.equal(stopReasonLabel("title-excluded"), "title excluded")
})

test("stopReasonLabel returns undefined for an unknown or missing reason", () => {
  assert.equal(stopReasonLabel(undefined), undefined, "a missing stop reason has no phrase")
  assert.equal(stopReasonLabel("not-a-stop-reason"), undefined, "an unknown stop reason has no phrase")
})

test("stopReasonLabel returns undefined for an inherited Object.prototype key", () => {
  // Both label maps are plain object literals, so a bare lookup resolves
  // "constructor" to Object and "toString" to the inherited function. The
  // footer would then render "· function Object() { [native code] }" instead
  // of omitting the suffix. The reason string arrives untyped from the event
  // payload, so the lookup must be an own-property check.
  for (const inheritedKey of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
    assert.equal(
      stopReasonLabel(inheritedKey),
      undefined,
      `the inherited key "${inheritedKey}" must not resolve to a stop-reason phrase`,
    )
  }
})

test("watchStateLabel maps every watch state to a non-empty label", () => {
  const watchStates: WatchStatusView["state"][] = ["watching", "confirming", "paused", "stopped", "done"]
  for (const state of watchStates) {
    const label = watchStateLabel(state)
    assert.ok(typeof label === "string" && label.length > 0, `${state} must map to a non-empty label`)
    assert.equal(label, WATCH_STATE_LABELS[state], `${state} must resolve to its mapped label`)
  }
  assert.equal(
    Object.keys(WATCH_STATE_LABELS).length,
    watchStates.length,
    "the state label map must cover exactly the five watch states",
  )
})

test("watchStateLabel falls back to a visibly raw value for an unknown state", () => {
  const label = watchStateLabel("a-state-this-build-does-not-know")
  assert.equal(label, "unknown state (a-state-this-build-does-not-know)")
  assert.ok(label.length > 0, "the fallback must never be empty")
})

test("watchStateLabel does not resolve an inherited Object.prototype key", () => {
  for (const inheritedKey of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
    const label = watchStateLabel(inheritedKey)
    assert.equal(typeof label, "string", `the inherited key "${inheritedKey}" must not resolve to a function`)
    assert.ok(
      label.startsWith("unknown state ("),
      `the inherited key "${inheritedKey}" must fall back to the raw-value form`,
    )
  }
})

test("the sidebar row and the status toast render the state through watchStateLabel", () => {
  // The raw protocol value must never reach the user directly — both
  // surfaces go through the label map so "confirming" reads as a review
  // round instead of an internal enum token.
  const source = readRepo("src/tui.tsx")
  assert.ok(
    source.includes("watchStateLabel(status.state)"),
    "the sidebar state row must go through watchStateLabel",
  )
  assert.ok(
    source.includes("watchStateLabel(result.state.state)"),
    "the status toast must go through watchStateLabel",
  )
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
  // Stronger staleness guard: the extracted pure logic module must also be in
  // the bundle, otherwise the bundle predates the src/tui-logic.ts extraction.
  assert.ok(
    bundle.includes("mergeWatchState"),
    "dist/tui.js lacks mergeWatchState — stale bundle, run npm run build:tui",
  )
  assert.ok(
    bundle.includes("formatDuration"),
    "dist/tui.js lacks formatDuration — stale bundle, run npm run build:tui",
  )
})

// --- formatDuration: the duration format table ---

test("formatDuration renders the documented duration format", () => {
  const cases: Array<{ milliseconds: number; expected: string }> = [
    { milliseconds: 0, expected: "0s" },
    { milliseconds: -1, expected: "0s" },
    { milliseconds: Number.NaN, expected: "0s" },
    { milliseconds: Number.POSITIVE_INFINITY, expected: "0s" },
    { milliseconds: 500, expected: "0s" },
    { milliseconds: 1_000, expected: "1s" },
    { milliseconds: 59_999, expected: "59s" },
    { milliseconds: 60_000, expected: "1m 0s" },
    { milliseconds: 61_000, expected: "1m 1s" },
    { milliseconds: 3_599_000, expected: "59m 59s" },
    { milliseconds: 3_600_000, expected: "1h 0m" },
    { milliseconds: 3_661_000, expected: "1h 1m" },
    { milliseconds: 86_400_000, expected: "1d 0h" },
    { milliseconds: 90_000_000, expected: "1d 1h" },
  ]
  for (const { milliseconds, expected } of cases) {
    assert.equal(formatDuration(milliseconds), expected, `formatDuration(${milliseconds}) must be "${expected}"`)
  }
})

// --- mergeWatchState: the state.changed merge rule ---

function watchStatusView(overrides: Partial<WatchStatusView>): WatchStatusView {
  return {
    sessionID: "ses_watch",
    state: "watching",
    injections: 0,
    ...overrides,
  }
}

function watchStateChanged(overrides: Partial<WatchStateChanged>): WatchStateChanged {
  return {
    sessionID: "ses_watch",
    state: "watching",
    injections: 0,
    ...overrides,
  }
}

test("mergeWatchState clears a stale stop reason when the round is live again", () => {
  const activeStates = ["watching", "confirming", "paused", "done"]
  for (const activeState of activeStates) {
    const current = watchStatusView({ state: "stopped", stopReason: "injection-cap" })
    const merged = mergeWatchState(current, watchStateChanged({ state: activeState }))
    assert.ok(merged, `state "${activeState}" must produce a merged view`)
    assert.equal(merged.state, activeState)
    assert.equal(merged.stopReason, undefined, `state "${activeState}" must drop the stale stop reason`)
  }
})

test("mergeWatchState keeps the stop reason of a stopped round", () => {
  const merged = mergeWatchState(
    watchStatusView({ state: "watching" }),
    watchStateChanged({ state: "stopped", stopReason: "watch-timeout" }),
  )
  assert.ok(merged)
  assert.equal(merged.state, "stopped")
  assert.equal(merged.stopReason, "watch-timeout")
})

test("mergeWatchState returns undefined for a stopped round without a reason", () => {
  const merged = mergeWatchState(
    watchStatusView({ state: "watching" }),
    watchStateChanged({ state: "stopped" }),
  )
  assert.equal(merged, undefined, "a plain unwatch carries nothing to merge")
})

test("mergeWatchState returns undefined for an unknown state", () => {
  const merged = mergeWatchState(
    watchStatusView({ state: "watching" }),
    watchStateChanged({ state: "bogus" }),
  )
  assert.equal(merged, undefined, "an unknown state carries nothing to merge")
})

test("mergeWatchState inherits the fields the event does not carry", () => {
  const current = watchStatusView({
    since: 1_000,
    lastInjectedAt: 2_000,
    totalInjections: 7,
    rejections: 3,
    verifying: true,
    toolFailureCount: 4,
  })
  const merged = mergeWatchState(current, watchStateChanged({ state: "confirming" }))
  assert.ok(merged)
  assert.equal(merged.since, 1_000, "the start time must survive the merge")
  assert.equal(merged.lastInjectedAt, 2_000, "the last injection time must survive the merge")
  assert.equal(merged.totalInjections, 7, "an absent totalInjections must not clear the current value")
  assert.equal(merged.rejections, 3, "an absent rejections must not clear the current value")
  assert.equal(merged.verifying, true, "an absent verifying flag must not clear the current value")
  assert.equal(merged.toolFailureCount, 4, "an absent toolFailureCount must not clear the current value")
})

test("mergeWatchState overwrites the optional fields the event carries", () => {
  const current = watchStatusView({
    totalInjections: 7,
    rejections: 3,
    verifying: true,
    toolFailureCount: 4,
  })
  const merged = mergeWatchState(
    current,
    watchStateChanged({
      state: "watching",
      totalInjections: 11,
      rejections: 0,
      verifying: false,
      toolFailureCount: 0,
    }),
  )
  assert.ok(merged)
  assert.equal(merged.totalInjections, 11)
  assert.equal(merged.rejections, 0)
  assert.equal(merged.verifying, false)
  assert.equal(merged.toolFailureCount, 0)
})

test("mergeWatchState builds a fresh view when there is no current state", () => {
  const merged = mergeWatchState(undefined, watchStateChanged({ state: "watching", injections: 2 }))
  assert.ok(merged)
  assert.deepEqual(merged, {
    sessionID: "ses_watch",
    state: "watching",
    injections: 2,
    stopReason: undefined,
  })
  assert.ok(!("since" in merged), "a fresh view must not invent a start time")
  assert.ok(!("lastInjectedAt" in merged), "a fresh view must not invent a last injection time")
})

test("mergeWatchState does not modify the current view in place", () => {
  const current = watchStatusView({ state: "stopped", stopReason: "injection-cap" })
  const merged = mergeWatchState(current, watchStateChanged({ state: "watching" }))
  assert.ok(merged)
  assert.notEqual(merged, current, "the merge must return a new object")
  assert.equal(current.state, "stopped", "the current view must not be modified")
  assert.equal(current.stopReason, "injection-cap", "the current view must not be modified")
})

// --- T1 guard: the refreshStatus catch branch must not drop the entry ---

test("the refreshStatus catch branch never calls updateStatus", () => {
  // SOURCE-LEVEL GUARD: src/tui.tsx cannot be imported by the test harness
  // (TSX + host externals), so the refreshStatus body is inspected as text.
  // The body is cut with a regex from "async function refreshStatus" up to
  // the next top-level async function, so unrelated code cannot influence
  // the result.
  const source = readRepo("src/tui.tsx")
  const functionMatch = /async function refreshStatus[\s\S]*?(?=\n {4}async function)/.exec(source)
  assert.ok(functionMatch, "src/tui.tsx must define refreshStatus")
  const functionBody = functionMatch[0]

  // The catch branch is extracted by brace matching so that neither a
  // comment mentioning "catch" nor the try block above it can influence the
  // result.
  const catchMatch = /\bcatch\b[^{]*\{/.exec(functionBody)
  assert.ok(catchMatch, "refreshStatus must have a catch branch")
  const blockStart = catchMatch.index + catchMatch[0].length - 1
  let depth = 0
  let blockEnd = -1
  for (let index = blockStart; index < functionBody.length; index++) {
    const character = functionBody[index]
    if (character === "{") depth++
    else if (character === "}") {
      depth--
      if (depth === 0) {
        blockEnd = index
        break
      }
    }
  }
  assert.ok(blockEnd > blockStart, "the catch branch must have a brace-delimited body")
  const catchBranch = functionBody.slice(blockStart, blockEnd + 1)
  // Comments are stripped so a note about updateStatus cannot fail the guard.
  const catchCode = catchBranch.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  assert.ok(
    !catchCode.includes("updateStatus("),
    "a failed status query must keep the entry — the catch branch must not call updateStatus",
  )
  // The success path still removes the entry when the server explicitly says
  // the session is not watched anymore.
  assert.ok(
    functionBody.includes("updateStatus(sessionID, undefined)"),
    "the success path must still remove the entry for a session that is no longer watched",
  )
})
