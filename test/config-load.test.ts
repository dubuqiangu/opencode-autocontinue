// Coverage for src/config.ts: the two-layer loadConfig() merge (global file +
// project file) and the maxConsecutive guardrails.
//
// loadConfig() reads the GLOBAL config from the user's home directory
// (~/.config/opencode/opencode-autocontinue.jsonc). A test that calls it
// without isolating the home would read — and be shaped by — the developer's
// real configuration. Every test below points the home directory at a
// throwaway temp directory (os.homedir() honours USERPROFILE on Windows and
// HOME on POSIX) and restores the original environment afterwards.
//
// Run: node --experimental-strip-types --test test/config-load.test.ts

import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../src/config.ts"
import { WatchStore } from "../src/state.ts"
import { createEngine, disposeEngines, FakeStorage, makeFakeSession } from "./support/harness.ts"

const originalUserProfile = process.env.USERPROFILE
const originalHome = process.env.HOME
const temporaryDirectories: string[] = []

afterEach(() => {
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  disposeEngines()
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

interface IsolatedEnvironment {
  homeDirectory: string
  projectDirectory: string
}

/** Point the home directory at a temp dir and return fresh project dir. */
function isolateHome(): IsolatedEnvironment {
  const homeDirectory = mkdtempSync(join(tmpdir(), "opencode-autocontinue-home-"))
  const projectDirectory = mkdtempSync(join(tmpdir(), "opencode-autocontinue-project-"))
  temporaryDirectories.push(homeDirectory, projectDirectory)
  process.env.USERPROFILE = homeDirectory
  process.env.HOME = homeDirectory
  return { homeDirectory, projectDirectory }
}

function writeGlobalConfig(homeDirectory: string, contents: string): void {
  const configDirectory = join(homeDirectory, ".config", "opencode")
  mkdirSync(configDirectory, { recursive: true })
  writeFileSync(join(configDirectory, "opencode-autocontinue.jsonc"), contents, "utf-8")
}

function writeProjectConfig(projectDirectory: string, contents: string): void {
  const configDirectory = join(projectDirectory, ".opencode")
  mkdirSync(configDirectory, { recursive: true })
  writeFileSync(join(configDirectory, "opencode-autocontinue.jsonc"), contents, "utf-8")
}

test("loadConfig returns the shipped defaults when no config file exists", () => {
  const { projectDirectory } = isolateHome()
  const config = loadConfig(projectDirectory)
  assert.equal(config.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)
  assert.equal(config.watchTimeoutMs, DEFAULT_CONFIG.watchTimeoutMs)
  assert.equal(config.message, DEFAULT_CONFIG.message)
  assert.equal(config.endTime, DEFAULT_CONFIG.endTime)
})

test("loadConfig reads the global config file from the isolated home directory", () => {
  const { homeDirectory, projectDirectory } = isolateHome()
  writeGlobalConfig(homeDirectory, '{ "message": "全局消息", "maxConsecutive": 7 }')
  const config = loadConfig(projectDirectory)
  assert.equal(config.message, "全局消息")
  assert.equal(config.maxConsecutive, 7)
})

test("loadConfig merges the project config over the global config", () => {
  const { homeDirectory, projectDirectory } = isolateHome()
  writeGlobalConfig(
    homeDirectory,
    '{ "message": "全局消息", "maxConsecutive": 7, "idleDelayMs": 1111, "endTime": "23:30" }',
  )
  writeProjectConfig(projectDirectory, '{ "message": "项目消息", "idleDelayMs": 2222 }')
  const config = loadConfig(projectDirectory)
  // Same key: the project level wins.
  assert.equal(config.message, "项目消息")
  assert.equal(config.idleDelayMs, 2222)
  // Different keys: both layers survive the merge.
  assert.equal(config.maxConsecutive, 7)
  assert.equal(config.endTime, "23:30")
})

test("loadConfig replaces list values instead of concatenating them", () => {
  const { homeDirectory, projectDirectory } = isolateHome()
  writeGlobalConfig(homeDirectory, '{ "completionMarkers": ["[global-done]"] }')
  writeProjectConfig(projectDirectory, '{ "completionMarkers": ["[project-done]"] }')
  const config = loadConfig(projectDirectory)
  assert.deepEqual(config.completionMarkers, ["[project-done]"])
})

test("loadConfig ignores the real user configuration directory", () => {
  // The isolated home has no config file at all, so every value must be the
  // shipped default — in particular the real user's endTime must not leak in.
  const { projectDirectory } = isolateHome()
  const config = loadConfig(projectDirectory)
  assert.equal(config.endTime, DEFAULT_CONFIG.endTime)
  assert.equal(config.startTime, DEFAULT_CONFIG.startTime)
  assert.equal(config.message, DEFAULT_CONFIG.message)
})

test("loadConfig tolerates a project directory without a config file", () => {
  const { homeDirectory, projectDirectory } = isolateHome()
  writeGlobalConfig(homeDirectory, '{ "maxConsecutive": 5 }')
  const config = loadConfig(projectDirectory)
  assert.equal(config.maxConsecutive, 5)
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
