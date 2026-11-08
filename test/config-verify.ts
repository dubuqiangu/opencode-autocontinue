import { readFileSync } from "node:fs"
import {
  parseJsonc,
  DEFAULT_CONFIG,
  loadConfig,
  buildCompletionMatcher,
  globalConfigPath,
} from "../src/config.ts"

const configPath = globalConfigPath()

// The global config file is optional: when it does not exist, loadConfig()
// falls back to the defaults. Only the raw-file diagnostics are skipped in
// that case; the loadConfig() diagnostics below still run.
let rawConfigText: string | null = null
try {
  rawConfigText = readFileSync(configPath, "utf8")
} catch (error) {
  const errorCode = (error as { code?: string }).code
  if (errorCode !== "ENOENT") throw error
  console.log("config file not found:", configPath)
  console.log("skipping raw file diagnostics; loadConfig() will use the defaults")
}

if (rawConfigText !== null) {
  const parsed = parseJsonc(rawConfigText)
  console.log("bytes 0-2:", JSON.stringify([...rawConfigText.slice(0, 3)]))
  console.log("has message:", Object.prototype.hasOwnProperty.call(parsed, "message"))
  console.log("parsed message:", parsed.message)
  console.log("endTime:", parsed.endTime, "| maxConsecutive:", parsed.maxConsecutive)
}

// Full loadConfig path (global + project override) with the real file.
const loadedConfig = loadConfig(process.cwd())
console.log("loaded enabled:", loadedConfig.enabled)
console.log("loaded message:", loadedConfig.message)
const matcher = buildCompletionMatcher(loadedConfig)
if (matcher === null) {
  // A config with no usable completion marker yields a null matcher. Calling
  // .test() on it would throw and hide every remaining diagnostic, so the two
  // marker lines report "n/a" instead — the lines stay present either way so
  // the output shape stays stable while eyeballing a config.
  console.log("marker matches [任务完成]: n/a (no completion marker configured)")
  console.log("marker matches [task done]: n/a (no completion marker configured)")
} else {
  console.log("marker matches [任务完成]:", matcher.test("[任务完成] 一切就绪"))
  console.log("marker matches [task done]:", matcher.test("done: [task done]"))
}
console.log("DEFAULT message:", DEFAULT_CONFIG.message)
