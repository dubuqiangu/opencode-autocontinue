// v0.3.9 TUI delivery guards (oracle Experiment C, headless).
// The TUI render path ships as a prebuilt dist/tui.js bundle with all
// @opentui/* and solid-js external (host-provided at runtime). These static
// guards fail loudly if someone reintroduces a parasitic solid copy
// (solid-js/dist deep-path import), a peerDependencies shadow copy, a stale
// bundle, or an exports entry that bypasses the bundle.
// Run: node --test test/server.test.ts test/session-resolution.test.ts test/tui-delivery.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

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