// Contract guards for src/rpc.ts — the single source of truth for stop
// reasons. The RPC schemas are validated by the host runtime (additional
// properties are rejected, undefined values do not satisfy {type:"string"}),
// so a drift between the schema enum and the reason list breaks the wire
// contract at runtime. These guards keep the schema, the exported list and
// the server-side re-export in lockstep.
//
// Run: node --experimental-strip-types --test test/rpc-contract.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { AUTOCONTINUE_RPC_CONTRACT, STOP_REASONS } from "../src/rpc.ts"
import { STOP_REASONS as STATE_STOP_REASONS } from "../src/state.ts"

test("STOP_REASONS lists exactly eight distinct stop reasons", () => {
  assert.equal(STOP_REASONS.length, 8, "the canonical stop-reason list must hold exactly eight entries")
  assert.equal(
    new Set(STOP_REASONS).size,
    STOP_REASONS.length,
    "the canonical stop-reason list must not repeat a value",
  )
})

test("STOP_REASONS contains the title-excluded reason", () => {
  assert.ok(
    (STOP_REASONS as readonly string[]).includes("title-excluded"),
    "a title that hits excludeTitleKeywords must have its own stop reason",
  )
})

test("the status output schema derives its stopReason enum from STOP_REASONS", () => {
  const stopReasonSchema = AUTOCONTINUE_RPC_CONTRACT.methods.status.output.properties.state.properties
    .stopReason
  assert.equal(stopReasonSchema.type, "string")
  assert.deepEqual(
    [...stopReasonSchema.enum],
    [...STOP_REASONS],
    "the status stopReason enum must match STOP_REASONS exactly (same values, same order)",
  )
})

test("the state.changed event schema derives its stopReason enum from STOP_REASONS", () => {
  const stopReasonSchema =
    AUTOCONTINUE_RPC_CONTRACT.events["state.changed"].schema.properties.stopReason
  assert.equal(stopReasonSchema.type, "string")
  assert.deepEqual(
    [...stopReasonSchema.enum],
    [...STOP_REASONS],
    "the state.changed stopReason enum must match STOP_REASONS exactly (same values, same order)",
  )
})

test("the status and state.changed schemas agree on the stop-reason enum", () => {
  const statusEnum = [
    ...AUTOCONTINUE_RPC_CONTRACT.methods.status.output.properties.state.properties.stopReason.enum,
  ]
  const eventEnum = [
    ...AUTOCONTINUE_RPC_CONTRACT.events["state.changed"].schema.properties.stopReason.enum,
  ]
  assert.deepEqual(statusEnum, eventEnum)
})

test("the status state object rejects unknown properties", () => {
  // The host validator uses additionalProperties:false, so an omitted key is
  // the only legal way to say "this round has no stop reason".
  const stateSchema = AUTOCONTINUE_RPC_CONTRACT.methods.status.output.properties.state
  assert.equal(stateSchema.additionalProperties, false)
  assert.equal(
    AUTOCONTINUE_RPC_CONTRACT.events["state.changed"].schema.additionalProperties,
    false,
  )
})

test("src/state.ts re-exports the very same stop-reason list", () => {
  assert.equal(
    STATE_STOP_REASONS,
    STOP_REASONS,
    "src/state.ts must re-export the rpc.ts list, not define a second copy",
  )
  assert.deepEqual([...STATE_STOP_REASONS], [...STOP_REASONS])
})
