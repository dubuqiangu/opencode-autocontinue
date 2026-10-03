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
  /** Delay after the session goes idle before injecting. */
  idleDelayMs: number
  /** Minimum gap between two injections in the same session. */
  minIntervalMs: number
  /** Max consecutive auto-injections per session before giving up. */
  maxConsecutive: number
  /** Last assistant message matching any marker stops the session's watching. */
  completionMarkers: string[]
  /** Optional raw regex replacing completionMarkers. */
  markerRegex: string
  /** Error substrings (case-insensitive) that make a failure auto-continue. */
  errorPatterns: string[]
  /** Error substrings that never auto-continue (user-initiated aborts etc). */
  excludePatterns: string[]
  /** Session titles containing any keyword are never auto-continued. */
  excludeTitleKeywords: string[]
  /** After a real user message, wait this long before auto-injecting. */
  userGraceMs: number
}

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  message:
    "继续执行。审视已完成的功能是否存在bug，未实现的功能是否有安排好的执行计划",
  startTime: "",
  endTime: "",
  idleDelayMs: 15_000,
  minIntervalMs: 30_000,
  maxConsecutive: 20,
  completionMarkers: ["[任务完成]", "[夜间任务完成]", "[task done]", "<promise>DONE</promise>"],
  markerRegex: "",
  errorPatterns: [
    "bad_response_status_code",
    "bad request",
    "429",
    "5",
    "ECONNRESET",
    "ECONNREFUSED",
    "timeout",
    "aborted by",
    "ContextOverflow",
    "too large to compact",
  ],
  excludePatterns: ["MessageAbortedError", "operation was aborted"],
  excludeTitleKeywords: ["测试"],
  userGraceMs: 300_000,
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
    } else {
      result += char
      index++
    }
  }
  result = result.replace(/,\s*([}\]])/g, "$1")
  return JSON.parse(result)
}

export function mergeConfig(base: PluginConfig, raw: unknown): PluginConfig {
  if (!raw || typeof raw !== "object") return { ...base }
  const overrides = raw as Record<string, unknown>
  const merged: PluginConfig = { ...base }
  if (typeof overrides.enabled === "boolean") merged.enabled = overrides.enabled
  if (typeof overrides.message === "string" && overrides.message) merged.message = overrides.message
  if (typeof overrides.startTime === "string") merged.startTime = overrides.startTime
  if (typeof overrides.endTime === "string") merged.endTime = overrides.endTime
  if (typeof overrides.idleDelayMs === "number") merged.idleDelayMs = overrides.idleDelayMs
  if (typeof overrides.minIntervalMs === "number") merged.minIntervalMs = overrides.minIntervalMs
  if (typeof overrides.maxConsecutive === "number") merged.maxConsecutive = overrides.maxConsecutive
  if (Array.isArray(overrides.completionMarkers)) {
    merged.completionMarkers = overrides.completionMarkers.filter(
      (marker): marker is string => typeof marker === "string",
    )
  }
  if (typeof overrides.markerRegex === "string") merged.markerRegex = overrides.markerRegex
  if (Array.isArray(overrides.errorPatterns)) {
    merged.errorPatterns = overrides.errorPatterns.filter(
      (pattern): pattern is string => typeof pattern === "string",
    )
  }
  if (Array.isArray(overrides.excludePatterns)) {
    merged.excludePatterns = overrides.excludePatterns.filter(
      (pattern): pattern is string => typeof pattern === "string",
    )
  }
  if (Array.isArray(overrides.excludeTitleKeywords)) {
    merged.excludeTitleKeywords = overrides.excludeTitleKeywords.filter(
      (keyword): keyword is string => typeof keyword === "string",
    )
  }
  if (typeof overrides.userGraceMs === "number") merged.userGraceMs = overrides.userGraceMs
  return merged
}

function readConfigFile(filePath: string): unknown | null {
  try {
    return parseJsonc(readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}

/** Global config path under the user home. */
export function globalConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode-autocontinue.jsonc")
}

/** Load global config merged over defaults; optional project dir overrides it. */
export function loadConfig(projectDirectory?: string): PluginConfig {
  const merged = mergeConfig(DEFAULT_CONFIG, readConfigFile(globalConfigPath()))
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
  const escaped = config.completionMarkers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  if (escaped.length === 0) return null
  return new RegExp(escaped.join("|"), "i")
}