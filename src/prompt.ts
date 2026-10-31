// Continuation message rendering and injection for opencode-autocontinue.

/** Provenance stamp attached to every message this plugin injects. The engine
 *  reads it to tell a real user message from our own continuation, so an
 *  injection never resets the injection counter (the maxConsecutive guard). */
export const PROVENANCE_ORIGIN = "opencode-autocontinue"
export const PROVENANCE_KIND = "continuation"
export const PROVENANCE_METADATA: Record<string, unknown> = {
  origin: PROVENANCE_ORIGIN,
  kind: PROVENANCE_KIND,
}

/** True when a session message's metadata marks it as our own injection. */
export function isPluginInjection(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as { origin?: unknown }).origin === PROVENANCE_ORIGIN
  )
}

export interface SessionPromptLike {
  prompt(input: {
    sessionID: string
    text: string
    metadata?: Record<string, unknown>
  }): Promise<unknown>
  /** Optional host channel that lands the message as `type:"synthetic"` instead
   *  of `type:"user"` (this is the structurally-correct injection channel). */
  synthetic?(input: {
    sessionID: string
    text: string
    description?: string
    metadata?: Record<string, unknown>
    resume?: boolean
  }): Promise<unknown>
}

/** Render a message template replacing {time} and {remaining}. */
export function renderMessage(template: string, endAt: number): string {
  const now = new Date()
  const time = now.toLocaleString("zh-CN", { hour12: false })
  // P3-3: no window (endAt = 0) means there is no remaining time to report.
  const remainingMs = endAt > 0 ? Math.max(0, endAt - now.getTime()) : null
  const remaining =
    remainingMs === null
      ? "不限"
      : remainingMs >= 3_600_000
        ? `${(remainingMs / 3_600_000).toFixed(1)} 小时`
        : `${Math.max(1, Math.round(remainingMs / 60_000))} 分钟`
  return template.replace(/\{time\}/g, time).replace(/\{remaining\}/g, remaining)
}

/** Inject the rendered continuation message into a session.
 *  Prefers the `synthetic` channel (structurally distinguishable from a real
 *  user message) and falls back to `prompt`. Both paths carry the provenance
 *  metadata, so the counting fix holds even on hosts without `synthetic`.
 *  Returns the rendered text so the caller can arm its self-echo guard. */
export async function injectContinuation(
  session: SessionPromptLike,
  sessionID: string,
  template: string,
  endAt: number,
): Promise<string> {
  const text = renderMessage(template, endAt)
  if (typeof session.synthetic === "function") {
    try {
      await session.synthetic({
        sessionID,
        text,
        description: PROVENANCE_KIND,
        metadata: PROVENANCE_METADATA,
        resume: true,
      })
      return text
    } catch {
      // Older / partial hosts: fall through to prompt with the same metadata.
    }
  }
  await session.prompt({ sessionID, text, metadata: PROVENANCE_METADATA })
  return text
}
