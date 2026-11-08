// Coverage for src/config.ts: the two-layer loadConfig() merge (global file +
// project file) and the maxConsecutive guardrails.
//
// loadConfig() reads the GLOBAL config from the user's home directory
// (~/.config/opencode/opencode-autocontinue.jsonc). To keep these tests
// isolated from the developer's real configuration, every case injects an
// explicit global config path through LoadConfigOptions.globalConfigPath:
// either a file inside a throwaway temp directory, or a path that does not
// exist. The tests therefore never modify the USERPROFILE / HOME process
// environment variables, so several test files can run side by side in the
// same process without polluting each other.
//
// Run: node --experimental-strip-types --test test/config-load.test.ts

import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_CONFIG, globalConfigPath, loadConfig, mergeConfig, parseJsonc } from "../src/config.ts"
import { WatchStore } from "../src/state.ts"
import { createEngine, disposeEngines, FakeStorage, makeFakeSession } from "./support/harness.ts"

const temporaryDirectories: string[] = []

afterEach(() => {
  disposeEngines()
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

interface TestEnvironment {
  globalConfigDirectory: string
  projectDirectory: string
}

/** Create throwaway directories for the global config and the project config. */
function createTestEnvironment(): TestEnvironment {
  const globalConfigDirectory = mkdtempSync(join(tmpdir(), "opencode-autocontinue-global-"))
  const projectDirectory = mkdtempSync(join(tmpdir(), "opencode-autocontinue-project-"))
  temporaryDirectories.push(globalConfigDirectory, projectDirectory)
  return { globalConfigDirectory, projectDirectory }
}

/** Write a global config file under `directory` and return its absolute path. */
function writeGlobalConfig(directory: string, contents: string): string {
  const configDirectory = join(directory, ".config", "opencode")
  mkdirSync(configDirectory, { recursive: true })
  const configFile = join(configDirectory, "opencode-autocontinue.jsonc")
  writeFileSync(configFile, contents, "utf-8")
  return configFile
}

/** A global config path that points at a file which does not exist. */
function missingGlobalConfigPath(directory: string): string {
  return join(directory, ".config", "opencode", "missing-opencode-autocontinue.jsonc")
}

function writeProjectConfig(projectDirectory: string, contents: string): void {
  const configDirectory = join(projectDirectory, ".opencode")
  mkdirSync(configDirectory, { recursive: true })
  writeFileSync(join(configDirectory, "opencode-autocontinue.jsonc"), contents, "utf-8")
}

/** Run `action` with console.error captured; returns the result and the
 *  collected error messages (console.error is always restored). */
function withCapturedConsoleErrors<Result>(action: () => Result): { result: Result; messages: string[] } {
  const messages: string[] = []
  const originalError = console.error
  console.error = (...errorArguments: unknown[]) => {
    messages.push(errorArguments.map((argument) => String(argument)).join(" "))
  }
  try {
    return { result: action(), messages }
  } finally {
    console.error = originalError
  }
}

/** Mirror how src/config.ts reads the default global config file. */
function readDefaultGlobalConfig(): unknown | null {
  try {
    return parseJsonc(readFileSync(globalConfigPath(), "utf-8"))
  } catch {
    return null
  }
}

test("loadConfig returns the shipped defaults when no config file exists", () => {
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  const globalConfigFile = missingGlobalConfigPath(globalConfigDirectory)
  const config = loadConfig(projectDirectory, { globalConfigPath: globalConfigFile })
  assert.equal(config.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)
  assert.equal(config.watchTimeoutMs, DEFAULT_CONFIG.watchTimeoutMs)
  assert.equal(config.message, DEFAULT_CONFIG.message)
  assert.equal(config.endTime, DEFAULT_CONFIG.endTime)
})

test("loadConfig reads the global config file from the injected global config path", () => {
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  const globalConfigFile = writeGlobalConfig(
    globalConfigDirectory,
    '{ "message": "全局消息", "maxConsecutive": 7 }',
  )
  const config = loadConfig(projectDirectory, { globalConfigPath: globalConfigFile })
  assert.equal(config.message, "全局消息")
  assert.equal(config.maxConsecutive, 7)
})

test("loadConfig merges the project config over the global config", () => {
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  const globalConfigFile = writeGlobalConfig(
    globalConfigDirectory,
    '{ "message": "全局消息", "maxConsecutive": 7, "idleDelayMs": 1111, "endTime": "23:30" }',
  )
  writeProjectConfig(projectDirectory, '{ "message": "项目消息", "idleDelayMs": 2222 }')
  const config = loadConfig(projectDirectory, { globalConfigPath: globalConfigFile })
  // Same key: the project level wins.
  assert.equal(config.message, "项目消息")
  assert.equal(config.idleDelayMs, 2222)
  // Different keys: both layers survive the merge.
  assert.equal(config.maxConsecutive, 7)
  assert.equal(config.endTime, "23:30")
})

test("loadConfig replaces list values instead of concatenating them", () => {
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  const globalConfigFile = writeGlobalConfig(
    globalConfigDirectory,
    '{ "completionMarkers": ["[global-done]"] }',
  )
  writeProjectConfig(projectDirectory, '{ "completionMarkers": ["[project-done]"] }')
  const config = loadConfig(projectDirectory, { globalConfigPath: globalConfigFile })
  assert.deepEqual(config.completionMarkers, ["[project-done]"])
})

test("loadConfig ignores configuration outside the injected global config path", () => {
  // The injected path does not exist, so every value must be the shipped
  // default — in particular nothing from the real user's home directory
  // may leak in.
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  const globalConfigFile = missingGlobalConfigPath(globalConfigDirectory)
  assert.equal(existsSync(globalConfigFile), false)
  const config = loadConfig(projectDirectory, { globalConfigPath: globalConfigFile })
  assert.equal(config.endTime, DEFAULT_CONFIG.endTime)
  assert.equal(config.startTime, DEFAULT_CONFIG.startTime)
  assert.equal(config.message, DEFAULT_CONFIG.message)
  // Nothing outside the injected path was read: the result is exactly the
  // shipped defaults.
  assert.deepEqual(config, DEFAULT_CONFIG)
})

test("loadConfig tolerates a project directory without a config file", () => {
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  const globalConfigFile = writeGlobalConfig(globalConfigDirectory, '{ "maxConsecutive": 5 }')
  const config = loadConfig(projectDirectory, { globalConfigPath: globalConfigFile })
  assert.equal(config.maxConsecutive, 5)
})

test("loadConfig without options still uses the default global config path", () => {
  const expectedDefaultPath = join(homedir(), ".config", "opencode", "opencode-autocontinue.jsonc")
  assert.equal(globalConfigPath(), expectedDefaultPath)

  const { projectDirectory } = createTestEnvironment()
  // Without an injected path the loader reads exactly the default global file.
  const expectedConfig = mergeConfig(DEFAULT_CONFIG, readDefaultGlobalConfig())
  assert.deepEqual(loadConfig(projectDirectory), expectedConfig)
})

// --- maxConsecutive guardrails ---

test("mergeConfig falls back to the default injection cap for a negative maxConsecutive", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { maxConsecutive: -1 })
  assert.equal(
    merged.maxConsecutive,
    DEFAULT_CONFIG.maxConsecutive,
    "a negative cap must not silently cancel the injection ceiling",
  )
  assert.equal(mergeConfig(DEFAULT_CONFIG, { maxConsecutive: -20 }).maxConsecutive, 20)
})

test("mergeConfig falls back to the base injection cap for a negative maxConsecutive", () => {
  const merged = mergeConfig({ ...DEFAULT_CONFIG, maxConsecutive: 7 }, { maxConsecutive: -3 })
  assert.equal(merged.maxConsecutive, 7)
})

test("mergeConfig keeps 0 as the unlimited injection cap", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { maxConsecutive: 0 })
  assert.equal(merged.maxConsecutive, 0)
})

test("mergeConfig falls back to the default injection cap for a non-finite maxConsecutive", () => {
  assert.equal(mergeConfig(DEFAULT_CONFIG, { maxConsecutive: Number.NaN }).maxConsecutive, 20)
  assert.equal(
    mergeConfig(DEFAULT_CONFIG, { maxConsecutive: Number.POSITIVE_INFINITY }).maxConsecutive,
    20,
  )
})

test("a negative maxConsecutive does not turn the injection cap off in the engine", async () => {
  // The engine only enforces the ceiling when maxConsecutive > 0, so a
  // negative value that reached the engine would mean "inject forever".
  // The config layer must hand the engine the default cap instead.
  const config = mergeConfig(DEFAULT_CONFIG, { maxConsecutive: -5, minIntervalMs: 0 })
  assert.equal(config.maxConsecutive, 20)

  const session = makeFakeSession()
  const store = new WatchStore(new FakeStorage())
  await store.hydrate()
  const engine = createEngine(session, () => config, store, () => {})
  await store.watch("ses_negative_cap")

  for (let injection = 0; injection < 20; injection++) {
    await engine.maybeInject("ses_negative_cap")
  }
  assert.equal(session.prompts.length, 20)
  assert.equal(store.getState("ses_negative_cap")?.state, "watching")

  // The 21st attempt hits the ceiling and stops with the injection-cap reason.
  await engine.maybeInject("ses_negative_cap")
  assert.equal(session.prompts.length, 20)
  assert.equal(store.getState("ses_negative_cap")?.state, "stopped")
  assert.equal(store.getState("ses_negative_cap")?.stopReason, "injection-cap")
})

// --- A3: config loading diagnostics ---

test("loadConfig stays silent when the global config file does not exist", () => {
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  const globalConfigFile = missingGlobalConfigPath(globalConfigDirectory)
  const { result, messages } = withCapturedConsoleErrors(() =>
    loadConfig(projectDirectory, { globalConfigPath: globalConfigFile }),
  )
  assert.deepEqual(messages, [], "a missing config file is the normal case and must not be reported")
  assert.equal(result.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)
  assert.equal(result.message, DEFAULT_CONFIG.message)
  assert.equal(result.startTime, DEFAULT_CONFIG.startTime)
  assert.equal(result.endTime, DEFAULT_CONFIG.endTime)
})

test("loadConfig reports a global config file that cannot be parsed", () => {
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  const globalConfigFile = writeGlobalConfig(globalConfigDirectory, '{ "message": "unterminated }')
  const { result, messages } = withCapturedConsoleErrors(() =>
    loadConfig(projectDirectory, { globalConfigPath: globalConfigFile }),
  )
  assert.equal(messages.length, 1, "a broken config file must be reported exactly once")
  assert.ok(messages[0].includes(globalConfigFile), "the report must name the absolute config file path")
  assert.ok(
    /JSON|Unexpected|Expected/i.test(messages[0]),
    "the report must include the JSON parse error detail",
  )
  assert.equal(result.message, DEFAULT_CONFIG.message, "a broken config file falls back to the defaults")
  assert.equal(result.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)
})

test("loadConfig reports a global config path that cannot be read", () => {
  const { globalConfigDirectory, projectDirectory } = createTestEnvironment()
  // The injected path points at a DIRECTORY, so reading it fails with EISDIR
  // (not ENOENT) and the loader must report the broken path.
  const unreadableConfigPath = join(globalConfigDirectory, "not-a-file")
  mkdirSync(unreadableConfigPath, { recursive: true })
  const { result, messages } = withCapturedConsoleErrors(() =>
    loadConfig(projectDirectory, { globalConfigPath: unreadableConfigPath }),
  )
  assert.equal(messages.length, 1, "an unreadable config file must be reported exactly once")
  assert.ok(messages[0].includes(unreadableConfigPath), "the report must name the unreadable config path")
  assert.equal(result.message, DEFAULT_CONFIG.message, "an unreadable config file falls back to the defaults")
  assert.equal(result.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)
})
