// Session-ID resolution for TUI slot components (pure, unit-testable).
//
// Pitfall (fixed in v0.3.6): JSX function components receive a props
// WRAPPER, not the raw slot props — <FooterIndicator slotProps={X}/>
// invokes the component as FooterIndicator({slotProps: X}). Reading
// .sessionID off that wrapper is always undefined, so the slot-cached
// sessionID never populated and /autocontinue reported "No current
// session" even inside an active session. usage-meter's FooterStatus
// unwraps the same way (verified against the running host).

/** Props wrapper a JSX slot component receives from its call site. */
export interface SlotComponentProps {
  slotProps?: { sessionID?: unknown } | undefined
}

/**
 * Unwrap a JSX slot component's props wrapper and extract its sessionID.
 * Raw (unwrapped) slot props yield undefined BY DESIGN — passing the slot
 * props straight through is the pre-v0.3.6 bug shape and must stay
 * fruitless so the mistake cannot silently regress.
 */
export function slotSessionIDFrom(componentProps: SlotComponentProps | undefined): string | undefined {
  const sessionID = componentProps?.slotProps?.sessionID
  return typeof sessionID === "string" && sessionID ? sessionID : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/**
 * Full resolution chain for "which session is this surface acting on":
 * unwrapped slot props first (authoritative), then the slot-cached
 * sessionID, then the router params (unreliable during slash-command
 * execution). Every source is validated to a non-empty string.
 */
export function resolveSessionID(sources: {
  componentProps?: SlotComponentProps | undefined
  cachedSessionID?: string | undefined
  routerSessionID?: unknown
}): string | undefined {
  return (
    slotSessionIDFrom(sources.componentProps) ??
    nonEmptyString(sources.cachedSessionID) ??
    nonEmptyString(sources.routerSessionID) ??
    undefined
  )
}
