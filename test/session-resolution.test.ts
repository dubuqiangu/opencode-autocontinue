// Unit tests for the TUI session-ID resolution chain (pure module).
// Run: node --test test/session-resolution.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { slotSessionIDFrom, resolveSessionID } from "../src/session-resolution.ts"

test("slotSessionIDFrom unwraps the JSX props wrapper (v0.3.6 regression lock)", () => {
  // <FooterIndicator slotProps={X}/> invokes the component as
  // FooterIndicator({slotProps: X}) — reading .sessionID off the wrapper
  // itself was always undefined and produced "No current session".
  assert.equal(slotSessionIDFrom({ slotProps: { sessionID: "ses_wrapped" } }), "ses_wrapped")
})

test("slotSessionIDFrom rejects raw slot props and invalid sessionIDs by design", () => {
  // Raw slot props (the pre-v0.3.6 bug shape) must stay fruitless so the
  // mistake cannot silently regress; non-string/empty values yield undefined.
  assert.equal(slotSessionIDFrom({ sessionID: "ses_raw" } as any), undefined)
  assert.equal(slotSessionIDFrom({ slotProps: { sessionID: 42 } }), undefined)
  assert.equal(slotSessionIDFrom({ slotProps: { sessionID: "" } }), undefined)
  assert.equal(slotSessionIDFrom({ slotProps: {} }), undefined)
  assert.equal(slotSessionIDFrom(undefined), undefined)
})

test("resolveSessionID prefers slot props over cache over router", () => {
  const allSources = {
    componentProps: { slotProps: { sessionID: "ses_slot" } },
    cachedSessionID: "ses_cached",
    routerSessionID: "ses_router",
  }
  assert.equal(resolveSessionID(allSources), "ses_slot")
  assert.equal(
    resolveSessionID({ cachedSessionID: "ses_cached", routerSessionID: "ses_router" }),
    "ses_cached",
  )
  assert.equal(resolveSessionID({ routerSessionID: "ses_router" }), "ses_router")
  assert.equal(resolveSessionID({}), undefined)
})

test("resolveSessionID falls back to cache then router when slot props miss", () => {
  // The slash command runs with no slot props at all — the cache (fed by
  // the footer slot) is what makes /autocontinue work in-session.
  assert.equal(
    resolveSessionID({ componentProps: { slotProps: {} }, cachedSessionID: "ses_cached" }),
    "ses_cached",
  )
  assert.equal(
    resolveSessionID({ componentProps: undefined, cachedSessionID: undefined, routerSessionID: "ses_router" }),
    "ses_router",
  )
})
