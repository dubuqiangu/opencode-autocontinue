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

/** Normalize an error-like value into a matchable string "Name: message (status: N)".
 *  status 存在时拼入，让纯 5xx 裸状态（无 message）也能被 pattern 匹配。 */
export function errorToMatchString(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "")
  const err = error as Record<string, unknown>
  const name = typeof err.name === "string" ? err.name : ""
  const dataMessage = (err.data as Record<string, unknown> | undefined)?.message
  const message =
    (typeof dataMessage === "string" ? dataMessage : null) ??
    (typeof err.message === "string" ? err.message : "") ??
    ""
  const base = `${name}: ${message}`.trimEnd()
  const status = err.status
  if (status !== undefined && status !== null) {
    return `${base} (status: ${status})`
  }
  return base
}

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

/** Whether the last assistant message contains a completion marker.
 *  matcher 为 null（未配置任何完成标记）时一律返回 false，视为没有完成标记。 */
export function hasCompletionMarker(text: string, matcher: RegExp | null): boolean {
  if (!matcher) return false
  return matcher.test(text)
}

/** Check whether a session title contains any excluded keyword. */
export function titleExcluded(title: string | undefined, excludeKeywords: string[]): boolean {
  if (!title || excludeKeywords.length === 0) return false
  const lowered = title.toLowerCase()
  return excludeKeywords.some((keyword) => lowered.includes(keyword.toLowerCase()))
}