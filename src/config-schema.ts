// Configuration schema: the PluginConfig shape, the shipped defaults and the
// shared bounds that the validation layer clamps against.
//
// The implementation lives in sibling modules:
//   - config-parse.ts    — JSONC parsing
//   - config-validate.ts — merge + per-key validation

export interface PluginConfig {
  /** Master switch. OC_AUTOCONTINUE=0 disables the plugin entirely. */
  enabled: boolean
  /** Continuation message injected to resume the agent. Supports {time} and {remaining}. */
  message: string
  /** Optional time window (local HH:MM). Outside it, no auto-continue. */
  startTime: string
  /** End time (local HH:MM). Past it, all watching stops. */
  endTime: string
  /** Delay after the session goes idle (or after a retryable error) before checking. */
  idleDelayMs: number
  /** Minimum gap between two injections in the same session. */
  minIntervalMs: number
  /** Max total injections per watch round before giving up (0 = unlimited). */
  maxConsecutive: number
  /** Total watch timeout (ms) per round. 0 = no time limit. */
  watchTimeoutMs: number
  /** Last assistant message matching any marker triggers the final check flow. */
  completionMarkers: string[]
  /** Optional raw regex replacing completionMarkers. */
  markerRegex: string
  /** After a completion marker, inject this message asking for a whole-project
   *  review + doc sync, then watch for a final completion marker. */
  finalCheckEnabled: boolean
  /** Message injected when a completion marker first appears (final check round). */
  finalCheckMessage: string
  /** Error substrings (case-insensitive) that make a failure auto-continue. */
  errorPatterns: string[]
  /** Error substrings that never auto-continue (user-initiated aborts etc). */
  excludePatterns: string[]
  /** Session titles containing any keyword are never auto-continued. */
  excludeTitleKeywords: string[]
  /** After a real user message, wait this long before auto-injecting. */
  userGraceMs: number
  /** Periodic check interval (ms). 0 = disabled. Every interval, watching
   *  sessions get the unified `message` injected while idle (skipped while the
   *  model is busy, when done/stopped, or while a check is in flight). */
  intervalMs: number
  /** Verification command for verify-driven completion. Empty = Loop disabled. */
  verifyCommand: string
  /** Per-run verification timeout (ms); clamped to >= 1000. */
  verifyTimeoutMs: number
  /** Max failing verification rounds before stopping (0 = unlimited). */
  verifyMaxIterations: number
  /** Verification working directory. Empty = the session/project directory. */
  verifyCwd: string
  /** Self-echo window (ms): an inbound user message equal to our last injected
   *  text within this window is treated as our own echo, not a real user turn. */
  selfEchoWindowMs: number
  /** Paired abort sentinel tag (e.g. <loop-abort>stop</loop-abort>). Empty disables. */
  abortSentinelTag: string
  /** Paired pause sentinel tag (e.g. <loop-pause>need input</loop-pause>). Empty disables. */
  pauseSentinelTag: string
  /** Extra prompt appended once rejections >= 3 (reassess before acting). */
  escalationReassessMessage: string
  /** Extra prompt appended once rejections >= 5 (question the root cause). */
  escalationRootCauseMessage: string
  /** Pressure ladder appended on every rejection; a row is picked by rejection
   *  count. Empty = no pressure line. */
  escalationPressureLadder: string[]
  /** Opt-in tool-failure observation counter (observation only, never affects
   *  completion/stop decisions). */
  observeToolFailures: boolean
  /** Substrings (case-insensitive) that mark a real user message as an
   *  expression of dissatisfaction with the delivered quality. Empty = the
   *  frustration trigger is disabled. */
  frustrationTriggers: string[]
  /** Reminder appended to the next injection after a frustration hit. Only
   *  effective while frustrationTriggers is non-empty. */
  frustrationMessage: string
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  message:
    "继续执行。按既定计划推进；遇到问题先自查修复，勿中断整体任务。",
  startTime: "",
  endTime: "",
  idleDelayMs: 15_000,
  minIntervalMs: 30_000,
  maxConsecutive: 20,
  watchTimeoutMs: 86_400_000,
  completionMarkers: [
    "[任务完成]",
    "[夜间任务完成]",
    "[task done]",
    "<promise>DONE</promise>",
    "<promise>LOOP_DONE</promise>",
  ],
  markerRegex: "",
  finalCheckEnabled: true,
  finalCheckMessage:
    "请整体检查一遍项目是否存在遗漏或 bug，并同步整理项目相关文档。检查完毕确认无误后，输出完成标记。",
  errorPatterns: [
    "bad_response_status_code",
    "bad request",
    "429",
    "(status: 5",
    "ECONNRESET",
    "ECONNREFUSED",
    "timeout",
    "aborted by",
    "ContextOverflow",
    "too large to compact",
  ],
  excludePatterns: ["MessageAbortedError", "operation was aborted"],
  excludeTitleKeywords: ["测试"],
  userGraceMs: 15_000,
  intervalMs: 3_600_000,
  verifyCommand: "",
  verifyTimeoutMs: 120_000,
  verifyMaxIterations: 50,
  verifyCwd: "",
  selfEchoWindowMs: 10_000,
  abortSentinelTag: "loop-abort",
  pauseSentinelTag: "loop-pause",
  escalationReassessMessage:
    "REASSESS：重读验证输出、搜索相关源码、列 3 个不同假设再行动。不要再用同样的方法。",
  escalationRootCauseMessage: "你可能在解决错误的问题。退回到需求本身重新理解。",
  escalationPressureLadder: [
    "稳步推进。",
    "换方案，别原地打转。",
    "先用 git log 看看自己做了什么，读取当前会话迭代记录。",
    "穷尽了吗？用 git diff 确认没在重复。",
    "停下来重新审视根因，用完全不同的思路。",
    "退回去从需求本身重新质疑。",
  ],
  observeToolFailures: false,
  // P2: the frustration trigger is OFF by default (an empty trigger list) —
  // a false positive would push a rebuke into a normal round.
  frustrationTriggers: [],
  frustrationMessage:
    "用户明确表达了对质量的不满：换本质不同的方法重新推进，并贴出可核对的验证证据（命令 + 输出），不要只改措辞。",
}

/** Maximum accepted length of a user supplied markerRegex source. */
export const MAX_MARKER_REGEX_SOURCE_LENGTH = 1024

/** Largest delay (ms) a Node timer can represent. Larger values overflow and
 *  fire immediately, so they are clamped down to this ceiling. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Smallest positive periodic check interval (ms). A smaller positive value
 *  would hammer the session, so it is raised to this floor. */
export const MIN_PERIODIC_INTERVAL_MS = 1_000

/** Bounds of the per-run verification timeout (ms). */
export const MIN_VERIFY_TIMEOUT_MS = 1_000
export const MAX_VERIFY_TIMEOUT_MS = 3_600_000

/** Largest number of failing verification rounds that is accepted. */
export const MAX_VERIFY_ITERATIONS = 10_000

// Extract a readable message from an unknown thrown value.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
