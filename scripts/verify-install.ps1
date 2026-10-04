# verify-install.ps1 — opencode-autocontinue one-click install self-verification.
# Run from anywhere after git push:  pwsh <repo>/scripts/verify-install.ps1
#
# Chain: local HEAD pushed -> plugin update (with cache-bust fallback) ->
#        plugin list commit match -> on-disk installed version match ->
#        installed file tree mirrors the repo (src/test/docs counts) ->
#        host opencode.json registration.
# Prints a PASS/FAIL line per check; exits 0 only when every check passes.
#
# Known host quirk: `opencode plugin update` can report "No plugin updates
# available" while the on-disk copy stays at the OLD commit (HEAD-detection
# cache). The script therefore first tries update, then — if the registry
# does not reflect the pushed HEAD — clears the stale cache stamp and re-adds
# the plugin (remove + add), which forces a fresh clone. This matches the
# manual recovery used during v0.2.0 verification.
#
# This verifies the DISK state only — the running TUI still needs a full
# restart to pick the new code up (see docs/guides/install.md).
param(
  [string]$PluginId = "github:dubuqiangu/opencode-autocontinue",
  [int]$InstallTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path $PSScriptRoot -Parent
$script:failures = 0

function Assert-Check {
  param([string]$Label, [bool]$Condition, [string]$Detail = "")
  $suffix = if ($Detail) { "  ($Detail)" } else { "" }
  if ($Condition) {
    Write-Output ("PASS  " + $Label + $suffix)
  } else {
    Write-Output ("FAIL  " + $Label + $suffix)
    $script:failures++
  }
}

function Count-Files {
  param([string]$Directory)
  if (-not (Test-Path $Directory)) { return 0 }
  return @(Get-ChildItem $Directory -Recurse -File).Count
}

# What will actually ship: git-tracked files only.
function Count-TrackedFiles {
  param([string]$RepositoryRoot, [string]$Path)
  $trackedPaths = git -C $RepositoryRoot ls-files -- $Path
  if (-not $trackedPaths) { return 0 }
  return @($trackedPaths).Count
}

# Newest install stamp that actually contains a complete package (partial
# installs from an in-flight update have no node_modules yet).
function Resolve-InstalledPackage {
  param([string]$CacheRoot)
  $stamps = Get-ChildItem $CacheRoot -Directory -Filter "git-opencode-autocontinue-*" |
    ForEach-Object { Get-ChildItem $_.FullName -Directory } |
    Sort-Object Name -Descending
  foreach ($stamp in $stamps) {
    $packageDir = Join-Path $stamp.FullName "node_modules\opencode-autocontinue"
    if (Test-Path (Join-Path $packageDir "package.json")) { return $packageDir }
  }
  return $null
}

function Read-ListedCommit {
  $listLine = (opencode plugin list | Select-String -Pattern "autocontinue" | Select-Object -First 1).Line
  if (-not $listLine) { return $null }
  $plainLine = $listLine -replace "$([char]27)\[[0-9;]*m", ""
  foreach ($token in ($plainLine -split "\s+")) {
    if ($token -match "^[0-9a-f]{7,}$") { return $token }
  }
  return $null
}

# --- expected state, derived from the local repo ----------------------------------
$packageJson = Get-Content (Join-Path $repoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedVersion = $packageJson.version
$defaultBranch = (git -C $repoRoot symbolic-ref --short HEAD).Trim()
$localHead = (git -C $repoRoot rev-parse --short HEAD).Trim()
$originHead = (git -C $repoRoot rev-parse --short "origin/$defaultBranch").Trim()
Assert-Check "local HEAD is pushed (HEAD == origin/$defaultBranch)" ($localHead -eq $originHead) "HEAD=$localHead origin=$originHead"

$expectedSrcCount = Count-TrackedFiles $repoRoot "src"
$expectedTestCount = Count-TrackedFiles $repoRoot "test"
$expectedDocsCount = Count-TrackedFiles $repoRoot "docs"

# --- one-click update (returns early — poll for the install below) -----------------
Set-Location $env:USERPROFILE
$cacheRoot = Join-Path $env:USERPROFILE ".cache\opencode\npm"
$updateOutput = (opencode plugin update $PluginId 2>&1 | Out-String).Trim()
Write-Output ("update: " + $updateOutput)

# --- wait until the host registry reflects the pushed commit -----------------------
$installedCommit = $null
$installDeadline = (Get-Date).AddSeconds($InstallTimeoutSeconds)
while ((Get-Date) -lt $installDeadline) {
  $installedCommit = Read-ListedCommit
  if ($installedCommit -eq $localHead) { break }
  Start-Sleep -Seconds 2
}

# --- cache-bust fallback: update reported "no updates" but the registry still
#     shows the old commit. Clear the stale stamp and re-add from scratch. ---
if ($installedCommit -ne $localHead) {
  Write-Output ("update did not advance the install (registry=$installedCommit expected=$localHead); forcing re-add")
  Get-ChildItem $cacheRoot -Directory -Filter "git-opencode-autocontinue-*" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
  $null = opencode plugin remove $PluginId 2>&1 | Out-String
  $null = opencode plugin add $PluginId 2>&1 | Out-String
  $installedCommit = $null
  $installDeadline = (Get-Date).AddSeconds($InstallTimeoutSeconds)
  while ((Get-Date) -lt $installDeadline) {
    $installedCommit = Read-ListedCommit
    if ($installedCommit -eq $localHead) { break }
    Start-Sleep -Seconds 2
  }
}
Assert-Check "plugin list shows the pushed commit" ($installedCommit -eq $localHead) "installed=$installedCommit expected=$localHead"

# --- on-disk installed package (poll: the stamp lands slightly late) ----------------
$installedPkg = $null
$installedVersion = $null
$diskDeadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $diskDeadline) {
  $installedPkg = Resolve-InstalledPackage $cacheRoot
  if ($installedPkg) {
    $installedVersion = (Get-Content (Join-Path $installedPkg "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if ($installedVersion -eq $expectedVersion) { break }
  }
  Start-Sleep -Seconds 2
}
Assert-Check "on-disk installed version matches package.json" ($installedVersion -eq $expectedVersion) "installed=$installedVersion expected=$expectedVersion"

$installedSrcCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "src") } else { -1 }
$installedTestCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "test") } else { -1 }
$installedDocsCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "docs") } else { -1 }
Assert-Check "installed src tree mirrors the repo" ($installedSrcCount -eq $expectedSrcCount) "installed=$installedSrcCount repo=$expectedSrcCount"
Assert-Check "installed test tree mirrors the repo" ($installedTestCount -eq $expectedTestCount) "installed=$installedTestCount repo=$expectedTestCount"
Assert-Check "installed docs tree mirrors the repo" ($installedDocsCount -eq $expectedDocsCount) "installed=$installedDocsCount repo=$expectedDocsCount"

# --- host registration ---------------------------------------------------------------
$hostConfigPath = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
$hostConfig = if (Test-Path $hostConfigPath) {
  Get-Content $hostConfigPath -Raw -Encoding UTF8
} else { "" }
Assert-Check "plugin registered in opencode.json" ($hostConfig.Contains($PluginId))

Write-Output "----"
if ($script:failures -eq 0) {
  Write-Output ("VERIFY OK — v$expectedVersion @ $localHead fully installed")
  exit 0
}
Write-Output ("VERIFY FAILED — $script:failures check(s) failed")
exit 1