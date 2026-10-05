// Continuation message rendering and injection for opencode-autocontinue.

export interface SessionPromptLike {
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
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

/** Inject the rendered continuation message into a session. */
export async function injectContinuation(
  session: SessionPromptLike,
  sessionID: string,
  template: string,
  endAt: number,
): Promise<void> {
  const text = renderMessage(template, endAt)
  await session.prompt({ sessionID, text })
}