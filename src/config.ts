// Configuration loader for opencode-autocontinue.
// Global config lives at ~/.config/opencode/opencode-autocontinue.jsonc.
// A project-local .opencode/opencode-autocontinue.jsonc deep-merges over it.
//
// This file is the facade: the schema lives in config-schema.ts, the JSONC
// parser in config-parse.ts and the merge/validation layer in
// config-validate.ts.

import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

import { DEFAULT_CONFIG, errorMessage } from "./config-schema.ts"
import type { PluginConfig } from "./config-schema.ts"
import { parseJsonc } from "./config-parse.ts"
import { mergeConfig } from "./config-validate.ts"

export type { PluginConfig } from "./config-schema.ts"
export { DEFAULT_CONFIG } from "./config-schema.ts"
export { parseJsonc } from "./config-parse.ts"
export { mergeConfig } from "./config-validate.ts"

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
