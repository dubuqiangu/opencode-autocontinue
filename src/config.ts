// Configuration loader for opencode-autocontinue.
// Global config lives at ~/.config/opencode/opencode-autocontinue.jsonc.
// A project-local .opencode/opencode-autocontinue.jsonc deep-merges over it.

import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

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
const MAX_MARKER_REGEX_SOURCE_LENGTH = 1024

/** Largest delay (ms) a Node timer can represent. Larger values overflow and
 *  fire immediately, so they are clamped down to this ceiling. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

// Skip whitespace and comments starting at `from`, returning the index of the
// next meaningful character (or text.length when only trivia remains).
// The trailing-comma lookahead uses this so a comma followed by a comment and
// then a closing brace is still recognized as a trailing comma.
function skipTrivia(text: string, from: number): number {
  let position = from
  while (position < text.length) {
    const char = text[position]
    if (/\s/.test(char)) {
      position++
      continue
    }
    if (char === "/" && text[position + 1] === "/") {
      while (position < text.length && text[position] !== "\n") position++
      continue
    }
    if (char === "/" && text[position + 1] === "*") {
      position += 2
      while (position < text.length && !(text[position] === "*" && text[position + 1] === "/")) position++
      position += 2
      continue
    }
    return position
  }
  return Math.min(position, text.length)
}

// Keep only the usable entries of a config array: strings that are not empty.
// A blank entry is never useful — "" is a substring of every string, so an
// empty pattern would match every error and an empty marker every message.
function usableStringList(entries: unknown[]): string[] {
  return entries.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
}

// Extract a readable message from an unknown thrown value.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Validate an HH:MM local clock value. An empty string disables the window.
// Anything else must match ^\d{1,2}:\d{2}$ with hour <= 23 and minute <= 59;
// an invalid value is reported once and falls back to "no window".
function validatedClockTime(value: string, keyName: string): string {
  if (value === "") return value
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  const hours = match ? Number(match[1]) : Number.NaN
  const minutes = match ? Number(match[2]) : Number.NaN
  if (!match || hours > 23 || minutes > 59) {
    console.error(
      `[opencode-autocontinue] ignored invalid config "${keyName}": expected HH:MM (00:00-23:59), got ${JSON.stringify(value)}`,
    )
    return ""
  }
  return value
}

// Clamp a delay (ms) into the safe timer range: a negative delay would cancel
// the guardrail it belongs to, and a delay beyond the 32 bit timer ceiling
// overflows and fires immediately.
function clampedDelay(value: number, keyName: string): number {
  if (value > MAX_TIMER_DELAY_MS) {
    console.error(
      `[opencode-autocontinue] clamped config "${keyName}": ${value} exceeds the maximum timer delay of ${MAX_TIMER_DELAY_MS} ms`,
    )
    return MAX_TIMER_DELAY_MS
  }
  return Math.max(0, value)
}

/** Strip // and /* *\/ comments and trailing commas from JSONC, then JSON.parse.
 *  Single-quoted strings are normalized to double-quoted so JSON.parse accepts them. */
export function parseJsonc(text: string): unknown {
  // Tolerate a UTF-8 BOM written by some editors / PowerShell.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let result = ""
  let inString = false
  let quoteChar = ""
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      if (char === "\\" && index + 1 < text.length) {
        const next = text[index + 1]
        // JSON 不接受 \' 转义：单引号串转成双引号串后要还原成裸单引号。
        if (quoteChar === "'" && next === "'") {
          result += "'"
        } else {
          result += char + next
        }
        index += 2
        continue
      }
      if (char === quoteChar) {
        inString = false
        // 闭合统一写双引号，兼容 JSON.parse。
        result += '"'
        index++
        continue
      }
      // 单引号串内的裸双引号是普通字符，转成双引号串后必须转义，避免提前断串。
      if (quoteChar === "'" && char === '"') {
        result += '\\"'
      } else {
        result += char
      }
      index++
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quoteChar = char
      // 开头统一写双引号，兼容 JSON.parse。
      result += '"'
      index++
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++
    } else if (char === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++
      index += 2
    } else if (char === ",") {
      // Drop a real trailing comma only when the next non-whitespace char
      // closes the object/array. Commas inside strings never reach here
      // (handled by the inString branch above), so "a,}" stays intact.
      // Look past whitespace AND comments: "1, // note\n}" is a trailing comma.
      const lookahead = skipTrivia(text, index + 1)
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        index++
        continue
      }
      result += char
      index++
    } else {
      result += char
      index++
    }
  }
  return JSON.parse(result)
}

export function mergeConfig(base: PluginConfig, raw: unknown): PluginConfig {
  if (!raw || typeof raw !== "object") return { ...base }
  const overrides = raw as Record<string, unknown>
  const merged: PluginConfig = { ...base }
  if (typeof overrides.enabled === "boolean") merged.enabled = overrides.enabled
  if (typeof overrides.message === "string" && overrides.message) merged.message = overrides.message
  if (typeof overrides.startTime === "string") {
    merged.startTime = validatedClockTime(overrides.startTime, "startTime")
  }
  if (typeof overrides.endTime === "string") {
    merged.endTime = validatedClockTime(overrides.endTime, "endTime")
  }
  if (typeof overrides.idleDelayMs === "number" && Number.isFinite(overrides.idleDelayMs)) {
    merged.idleDelayMs = clampedDelay(overrides.idleDelayMs, "idleDelayMs")
  }
  if (typeof overrides.minIntervalMs === "number" && Number.isFinite(overrides.minIntervalMs)) {
    merged.minIntervalMs = clampedDelay(overrides.minIntervalMs, "minIntervalMs")
  }
  if (typeof overrides.maxConsecutive === "number" && Number.isFinite(overrides.maxConsecutive)) {
    if (overrides.maxConsecutive >= 0) {
      merged.maxConsecutive = overrides.maxConsecutive
    } else {
      // A negative cap is almost certainly a typo: the engine only enforces the
      // limit when `maxConsecutive > 0`, so a negative value would silently
      // cancel the only injection ceiling. Fall back to the base value, and to
      // the shipped default when the base value is unusable as well.
      merged.maxConsecutive =
        Number.isFinite(base.maxConsecutive) && base.maxConsecutive >= 0
          ? base.maxConsecutive
          : DEFAULT_CONFIG.maxConsecutive
    }
  }
  if (typeof overrides.watchTimeoutMs === "number" && Number.isFinite(overrides.watchTimeoutMs)) {
    merged.watchTimeoutMs = Math.max(0, overrides.watchTimeoutMs)
  }
  if (Array.isArray(overrides.completionMarkers)) {
    merged.completionMarkers = usableStringList(overrides.completionMarkers)
  }
  if (typeof overrides.markerRegex === "string") {
    const markerRegexSource = overrides.markerRegex
    if (markerRegexSource.length > MAX_MARKER_REGEX_SOURCE_LENGTH) {
      console.error(
        `[opencode-autocontinue] ignored invalid config "markerRegex": source is longer than ${MAX_MARKER_REGEX_SOURCE_LENGTH} characters`,
      )
    } else if (/\([^)]*[+*]\)[+*]/.test(markerRegexSource)) {
      console.error(
        `[opencode-autocontinue] ignored invalid config "markerRegex": nested quantifiers may cause catastrophic backtracking (ReDoS)`,
      )
    } else {
      try {
        new RegExp(markerRegexSource, "i")
        merged.markerRegex = markerRegexSource
      } catch (error) {
        console.error(
          `[opencode-autocontinue] ignored invalid config "markerRegex": ${errorMessage(error)}`,
        )
      }
    }
  }
  if (typeof overrides.finalCheckEnabled === "boolean") merged.finalCheckEnabled = overrides.finalCheckEnabled
  if (typeof overrides.finalCheckMessage === "string" && overrides.finalCheckMessage) {
    merged.finalCheckMessage = overrides.finalCheckMessage
  }
  if (Array.isArray(overrides.errorPatterns)) {
    merged.errorPatterns = usableStringList(overrides.errorPatterns)
  }
  if (Array.isArray(overrides.excludePatterns)) {
    merged.excludePatterns = usableStringList(overrides.excludePatterns)
  }
  if (Array.isArray(overrides.excludeTitleKeywords)) {
    merged.excludeTitleKeywords = usableStringList(overrides.excludeTitleKeywords)
  }
  if (typeof overrides.userGraceMs === "number" && Number.isFinite(overrides.userGraceMs)) {
    // 0 keeps its meaning ("do not wait"); only negatives are clamped away.
    merged.userGraceMs = Math.max(0, overrides.userGraceMs)
  }
  // intervalMs: 0 means periodic checks disabled (scheduleInterval honors <=0).
  // Preserve the P2-7 anti-spam floor (min 1s) only for positive values, so the
  // documented "0 = disabled" escape hatch is actually reachable via config.
  if (typeof overrides.intervalMs === "number" && Number.isFinite(overrides.intervalMs)) {
    if (overrides.intervalMs <= 0) {
      merged.intervalMs = 0
    } else {
      const flooredInterval = Math.max(1_000, overrides.intervalMs)
      if (flooredInterval > MAX_TIMER_DELAY_MS) {
        console.error(
          `[opencode-autocontinue] clamped config "intervalMs": ${overrides.intervalMs} exceeds the maximum timer delay of ${MAX_TIMER_DELAY_MS} ms`,
        )
        merged.intervalMs = MAX_TIMER_DELAY_MS
      } else {
        merged.intervalMs = flooredInterval
      }
    }
  }
  if (typeof overrides.verifyCommand === "string") merged.verifyCommand = overrides.verifyCommand
  if (typeof overrides.verifyTimeoutMs === "number" && Number.isFinite(overrides.verifyTimeoutMs)) {
    // Clamp 1s..3600s (对齐 dsh-pua configuration.ts:21-32).
    merged.verifyTimeoutMs = Math.min(3_600_000, Math.max(1_000, overrides.verifyTimeoutMs))
  }
  if (typeof overrides.verifyMaxIterations === "number" && Number.isFinite(overrides.verifyMaxIterations)) {
    // Clamp 0..10000 (0 = unlimited).
    merged.verifyMaxIterations = Math.min(10_000, Math.max(0, overrides.verifyMaxIterations))
  }
  if (typeof overrides.verifyCwd === "string") merged.verifyCwd = overrides.verifyCwd
  if (typeof overrides.selfEchoWindowMs === "number" && Number.isFinite(overrides.selfEchoWindowMs)) {
    merged.selfEchoWindowMs = Math.max(0, overrides.selfEchoWindowMs)
  }
  // Sentinel tags accept any string, including "" (which disables the sentinel).
  if (typeof overrides.abortSentinelTag === "string") merged.abortSentinelTag = overrides.abortSentinelTag
  if (typeof overrides.pauseSentinelTag === "string") merged.pauseSentinelTag = overrides.pauseSentinelTag
  if (typeof overrides.escalationReassessMessage === "string") {
    merged.escalationReassessMessage = overrides.escalationReassessMessage
  }
  if (typeof overrides.escalationRootCauseMessage === "string") {
    merged.escalationRootCauseMessage = overrides.escalationRootCauseMessage
  }
  // A provided array replaces the default (never concatenated); an explicit
  // empty array is honored so `escalationPressureLadder: []` disables the line.
  if (Array.isArray(overrides.escalationPressureLadder)) {
    merged.escalationPressureLadder = usableStringList(overrides.escalationPressureLadder)
  }
  if (typeof overrides.observeToolFailures === "boolean") merged.observeToolFailures = overrides.observeToolFailures
  // P2: the trigger list REPLACES the default (never concatenated) and an
  // explicit [] disables the frustration path. Blank entries are dropped.
  if (Array.isArray(overrides.frustrationTriggers)) {
    merged.frustrationTriggers = usableStringList(overrides.frustrationTriggers)
  }
  if (typeof overrides.frustrationMessage === "string") {
    merged.frustrationMessage = overrides.frustrationMessage
  }
  return merged
}

function readConfigFile(filePath: string): unknown | null {
  let fileContent: string
  try {
    fileContent = readFileSync(filePath, "utf-8")
  } catch (error) {
    // A missing config file is the normal case: stay silent and fall back to
    // the defaults. Any other failure (permissions, a directory in the way,
    // an I/O error) is worth reporting — swallowing it hides a broken setup.
    const errorCode = (error as { code?: string } | null)?.code
    if (errorCode === "ENOENT") return null
    console.error(
      `[opencode-autocontinue] failed to read config file ${filePath}: ${errorMessage(error)}`,
    )
    return null
  }
  try {
    return parseJsonc(fileContent)
  } catch (error) {
    console.error(
      `[opencode-autocontinue] failed to parse config file ${filePath}: ${errorMessage(error)}`,
    )
    return null
  }
}

/** Options for loadConfig(): let tests and tooling inject an isolated global
 *  config path instead of relying on the process environment. */
export interface LoadConfigOptions {
  /** Global config file to read instead of the default location under the user home.
   *  Omit to use globalConfigPath(). Test/tooling use this to avoid touching
   *  the real user configuration (or the process environment). */
  globalConfigPath?: string
}

/** Global config path under the user home. */
export function globalConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode-autocontinue.jsonc")
}

/** Load global config merged over defaults; optional project dir overrides it. */
export function loadConfig(projectDirectory?: string, options: LoadConfigOptions = {}): PluginConfig {
  const globalConfigFile = options.globalConfigPath ?? globalConfigPath()
  const merged = mergeConfig(DEFAULT_CONFIG, readConfigFile(globalConfigFile))
  if (projectDirectory) {
    const projectOverride = readConfigFile(join(projectDirectory, ".opencode", "opencode-autocontinue.jsonc"))
    if (projectOverride) return mergeConfig(merged, projectOverride)
  }
  return merged
}

/** Build the completion matcher from markerRegex or completionMarkers.
 *  Returns null when no markers are configured (empty completionMarkers and no
 *  valid markerRegex), so callers treat the session as "no completion marker"
 *  and keep auto-continuing instead of instantly marking the session done. */
export function buildCompletionMatcher(config: PluginConfig): RegExp | null {
  if (config.markerRegex) {
    try {
      return new RegExp(config.markerRegex, "i")
    } catch {
      // Fall through to markers on invalid regex.
    }
  }
  // Blank markers are dropped: an empty alternative would make the matcher
  // match every text (the same effect as the regex /(?:)/i).
  const escaped = config.completionMarkers
    .filter((marker) => marker.length > 0)
    .map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  if (escaped.length === 0) return null
  return new RegExp(escaped.join("|"), "i")
}