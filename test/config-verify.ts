import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonc, DEFAULT_CONFIG, loadConfig, buildCompletionMatcher } from "../src/config.ts"

const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
const configPath = join(home, ".config", "opencode", "opencode-autocontinue.jsonc")
const raw = readFileSync(configPath, "utf8")
const parsed = parseJsonc(raw)
console.log("bytes 0-2:", JSON.stringify([...raw.slice(0, 3)]))
console.log("has message:", Object.prototype.hasOwnProperty.call(parsed, "message"))
console.log("parsed message:", parsed.message)
console.log("endTime:", parsed.endTime, "| maxConsecutive:", parsed.maxConsecutive)

// Full loadConfig path (global + project override) with the real file.
const cfg = loadConfig(process.cwd())
console.log("loaded enabled:", cfg.enabled)
console.log("loaded message:", cfg.message)
const matcher = buildCompletionMatcher(cfg)
console.log("marker matches [任务完成]:", matcher.test("[任务完成] 一切就绪"))
console.log("marker matches [task done]:", matcher.test("done: [task done]"))
console.log("DEFAULT message:", DEFAULT_CONFIG.message)