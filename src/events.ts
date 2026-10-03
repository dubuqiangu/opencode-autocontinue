// Event parsing for opencode-autocontinue.
// V2 event payload shapes differ across versions: sessionID may be flat on the
// event or nested under `properties`. Extractors accept both.

export interface EventLike {
  type?: string
  sessionID?: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
  info?: Record<string, unknown>
  status?: unknown
  error?: unknown
}

/** Extract the sessionID from an event regardless of envelope shape. */
export function sessionIDFromEvent(event: EventLike): string | undefined {
  if (typeof event.sessionID === "string" && event.sessionID) return event.sessionID
  const nested = event.properties?.sessionID
  if (typeof nested === "string" && nested) return nested
  const dataNested = event.data?.sessionID
  if (typeof dataNested === "string" && dataNested) return dataNested
  return undefined
}

/** Extract the sessionID from a message.info object. */
export function sessionIDFromMessageInfo(info: Record<string, unknown> | undefined): string | undefined {
  const sessionID = info?.sessionID
  return typeof sessionID === "string" && sessionID ? sessionID : undefined
}

/** Normalize an error-like value into a matchable string "Name: message". */
export function errorToMatchString(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "")
  const err = error as Record<string, unknown>
  const name = typeof err.name === "string" ? err.name : ""
  const dataMessage = (err.data as Record<string, unknown> | undefined)?.message
  const message =
    (typeof dataMessage === "string" ? dataMessage : null) ??
    (typeof err.message === "string" ? err.message : "") ??
    ""
  return `${name}: ${message}`
}

/** Check whether an error matches a retryable pattern (and no exclude pattern). */
export function isRetryableError(
  error: unknown,
  errorPatterns: string[],
  excludePatterns: string[],
): boolean {
  const matchString = errorToMatchString(error).toLowerCase()
  for (const exclude of excludePatterns) {
    if (matchString.includes(exclude.toLowerCase())) return false
  }
  for (const pattern of errorPatterns) {
    if (matchString.includes(pattern.toLowerCase())) return true
  }
  return false
}

/** Extract all text parts from a message's parts array. */
export function messageText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n")
}

/** Whether the last assistant message contains a completion marker. */
export function hasCompletionMarker(text: string, matcher: RegExp): boolean {
  return matcher.test(text)
}

/** Check whether a session title contains any excluded keyword. */
export function titleExcluded(title: string | undefined, excludeKeywords: string[]): boolean {
  if (!title || excludeKeywords.length === 0) return false
  const lowered = title.toLowerCase()
  return excludeKeywords.some((keyword) => lowered.includes(keyword.toLowerCase()))
}