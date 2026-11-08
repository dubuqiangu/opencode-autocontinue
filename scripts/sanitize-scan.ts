// Pre-push sanitization scan per AGENTS.md §2.
// Scans git-tracked files only (git ls-files), four categories.
import { execSync } from "node:child_process"

const files = execSync("git ls-files", { encoding: "utf-8" })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)

// The account name of this machine is injected at runtime instead of being
// written into this file, so the literal never lands in the repository.
const accountName = process.env.USERNAME ?? process.env.USER ?? ""
const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const escapedAccountName = escapeForRegExp(accountName)

const patterns: Array<[RegExp, string]> = [
  // 1. Real credential shapes — match the shape itself, never a prose label.
  [/\d{8,10}:[A-Za-z0-9_-]{35}/, "telegram bot token"],
  [/xox[bap]-/, "slack token"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "github token"],
  [/sk-[A-Za-z0-9]{20,}/, "openai-style key"],
  [/AKIA[0-9A-Z]{16}/, "aws key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  // 2. Long literal assignments of secret-ish names
  [
    /(token|secret|password|api_key|app_secret)\s*[=:]\s*["'][^"']{16,}["']/i,
    "secret literal assignment",
  ],
  // 3. Privacy data
  // Absolute Windows home paths. Placeholder forms (C:\Users\<用户名>\) are
  // documentation, not leaks, so they are excluded explicitly.
  [/C:\\Users\\(?!<|\$|\{)[^\\"'\r\n]+/, "absolute user path"],
  [/%USERPROFILE%/, "userprofile var"],
  [/\bD:\\workSpace\b/, "workspace abs path"],
]

if (escapedAccountName.length > 0) {
  // The bare account name, guarded by non-alphanumeric boundaries so hex
  // digests and longer digit runs do not produce false positives.
  patterns.push([
    new RegExp(`(?<![A-Za-z0-9])${escapedAccountName}(?![A-Za-z0-9])`),
    "bare account name",
  ])
  // The POSIX home directory of this account (the /home/<用户名> shape).
  patterns.push([new RegExp(`/home/${escapedAccountName}`), "posix user home path"])
}

const findings: Array<{ file: string; label: string; match: string }> = []
const skippedFiles: string[] = []
for (const file of files) {
  // Skip the scanner itself: it defines the pattern literals, so self-matches
  // are structural (the tool's own regex text), not leaks. Pattern shapes are
  // checked on all other tracked files.
  if (file === "scripts/sanitize-scan.ts") {
    skippedFiles.push(file)
    continue
  }
  const content = execSync(`git show :${file}`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 })
  for (const [pattern, label] of patterns) {
    const match = content.match(pattern)
    if (match) findings.push({ file, label, match: match[0].slice(0, 80) })
  }
}

// 4. Runtime artifacts tracked (config/state/log/lock/cache). Matched by
// shape, not by exact file name, so config.jsonc / *.state.json / *.pid are
// covered as well.
const artifactFiles = files.filter((file) =>
  /(^|\/)(config\.jsonc?|state\.json|.*\.state\.json|.*\.log|.*\.session|.*\.local\.md|.*\.pid|.*\.lock|package-lock\.json|bun\.lock|pnpm-lock\.yaml)$/.test(
    file,
  ),
)

console.log("=== scanned files:", files.length, "===")
console.log("=== patterns applied:", patterns.length, "===")
if (skippedFiles.length > 0) {
  console.log("skipped (scanner defines the pattern literals):", skippedFiles.join(", "))
}
if (findings.length === 0) console.log("credential/secret/privacy scan: CLEAN")
else for (const finding of findings) console.log(`[${finding.label}] ${finding.file}: ${finding.match}`)

if (artifactFiles.length === 0) console.log("runtime artifact scan: CLEAN (no config/state/log/lock files tracked)")
else console.log("runtime artifacts tracked:", artifactFiles.join(", "))
