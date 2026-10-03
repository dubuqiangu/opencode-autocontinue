// Pre-push sanitization scan per AGENTS.md §2.
// Scans git-tracked files only (git ls-files), four categories.
import { execSync } from "node:child_process"

const files = execSync("git ls-files", { encoding: "utf-8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)

const patterns = [
  // 1. Real credential shapes
  [/Telegram bot token: \d{8,10}:[A-Za-z0-9_-]{35}/, "telegram bot token"],
  [/xox[bap]-/, "slack token"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "github token"],
  [/sk-[A-Za-z0-9]{20,}/, "openai-style key"],
  [/AKIA[0-9A-Z]{16}/, "aws key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  // 2. Long literal assignments of secret-ish names
  [/(token|secret|password|api_key|app_secret)\s*[=:]\s*["'][^"']{16,}["']/i, "secret literal assignment"],
  // 3. Privacy data
  [/C:\\Users\\[^\\"']+/, "absolute user path"],
  [/%USERPROFILE%/, "userprofile var"],
  [/\bD:\\workSpace\b/, "workspace abs path"],
]

const findings = []
for (const file of files) {
  // Skip the scanner itself: it defines the pattern literals, so self-matches
  // are structural (the tool's own regex text), not leaks. Pattern shapes are
  // checked on all other tracked files.
  if (file === "scripts/sanitize-scan.ts") continue
  const content = execSync(`git show :${file}`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 })
  for (const [pattern, label] of patterns) {
    const match = content.match(pattern)
    if (match) findings.push({ file, label, match: match[0].slice(0, 80) })
  }
}

// 4. Runtime artifacts tracked (config/state/log/lock/cache)
const artifactFiles = files.filter((file) =>
  /(^|\/)(config\.json|state\.json|.*\.log|.*\.session|.*\.local\.md|package-lock\.json|bun\.lock|pnpm-lock\.yaml)$/.test(file),
)

console.log("=== scanned files:", files.length, "===")
if (findings.length === 0) console.log("credential/secret/privacy scan: CLEAN")
else for (const finding of findings) console.log(`[${finding.label}] ${finding.file}: ${finding.match}`)

if (artifactFiles.length === 0) console.log("runtime artifact scan: CLEAN (no config/state/log/lock files tracked)")
else console.log("runtime artifacts tracked:", artifactFiles.join(", "))