# verify-install.ps1 — opencode-autocontinue one-click install self-verification.
# Run from anywhere after git push:  pwsh <repo>/scripts/verify-install.ps1
#
# Chain: local HEAD pushed -> plugin update (with cache-bust fallback) ->
#        plugin list commit match -> on-disk installed version match ->
#        installed file tree mirrors the published package (src/test/docs/dist
#        file counts derived from the npm publish manifest) ->
#        host opencode.json registration -> headless server behavior
#        (test/install-verify.ts drives setup() with a mock context).
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

# What will actually ship: the npm publish manifest, i.e. the exact file list
# `npm pack` puts into the tarball. `git ls-files` over-counts, because the npm
# `files` allow-list may exclude repo files (e.g. manual verification scripts),
# so the expected counts must come from the publish manifest instead.
function Get-PublishManifest {
  param([string]$RepositoryRoot)
  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()
  try {
    Push-Location $RepositoryRoot
    try {
      & npm pack --dry-run --json --silent 1> $stdoutFile 2> $stderrFile
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    $stdoutText = ""
    if (Test-Path $stdoutFile) { $stdoutText = [System.IO.File]::ReadAllText($stdoutFile) }
    $stderrText = ""
    if (Test-Path $stderrFile) { $stderrText = [System.IO.File]::ReadAllText($stderrFile) }
    if ($exitCode -ne 0) {
      $stderrNote = ""
      if ($stderrText.Trim()) { $stderrNote = ": " + $stderrText.Trim() }
      return @{ Ok = $false; Paths = @(); Error = "npm pack --dry-run exited with code $exitCode" + $stderrNote }
    }
    # npm may prepend its own log lines to stdout; the manifest is the first
    # "[" that is followed by an object, and the array ends at the last "]".
    $jsonStart = -1
    for ($index = 0; $index -lt $stdoutText.Length; $index++) {
      if ($stdoutText[$index] -ne "[") { continue }
      $rest = $stdoutText.Substring($index + 1).TrimStart()
      if ($rest.StartsWith("{")) { $jsonStart = $index; break }
    }
    $jsonEnd = $stdoutText.LastIndexOf("]")
    if ($jsonStart -lt 0 -or $jsonEnd -le $jsonStart) {
      return @{ Ok = $false; Paths = @(); Error = "npm pack --dry-run produced no JSON manifest (stdout: " + $stdoutText.Trim() + ")" }
    }
    try {
      $manifest = ($stdoutText.Substring($jsonStart, $jsonEnd - $jsonStart + 1)) | ConvertFrom-Json
    } catch {
      return @{ Ok = $false; Paths = @(); Error = "npm pack --dry-run JSON could not be parsed: " + $_.Exception.Message }
    }
    $entries = @(@($manifest)[0].files)
    if (-not $entries -or $entries.Count -eq 0) {
      return @{ Ok = $false; Paths = @(); Error = "npm pack --dry-run manifest contains no file entries" }
    }
    $paths = @($entries | ForEach-Object { $_.path })
    return @{ Ok = $true; Paths = $paths; Error = "" }
  } catch {
    return @{ Ok = $false; Paths = @(); Error = $_.Exception.Message }
  } finally {
    Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
  }
}

# Count the manifest entries that live under one published directory.
# npm always reports forward slashes, on Windows too.
function Count-ManifestFiles {
  param([string[]]$ManifestPaths, [string]$DirectoryName)
  $prefix = $DirectoryName.TrimEnd("/") + "/"
  return @($ManifestPaths | Where-Object { $_.StartsWith($prefix) }).Count
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

# Expected file counts come from the publish manifest, so they describe what
# npm would actually ship — not everything git happens to track.
$publishManifest = Get-PublishManifest $repoRoot
if ($publishManifest.Ok) {
  $expectedSrcCount = Count-ManifestFiles $publishManifest.Paths "src"
  $expectedTestCount = Count-ManifestFiles $publishManifest.Paths "test"
  $expectedDocsCount = Count-ManifestFiles $publishManifest.Paths "docs"
  $expectedDistCount = Count-ManifestFiles $publishManifest.Paths "dist"
  $publishManifestNote = "manifest files=" + $publishManifest.Paths.Count
} else {
  # No manifest -> no valid expectation. The tree checks below fail loudly
  # instead of silently comparing against a different source of truth.
  $expectedSrcCount = "unavailable"
  $expectedTestCount = "unavailable"
  $expectedDocsCount = "unavailable"
  $expectedDistCount = "unavailable"
  $publishManifestNote = "publish manifest unavailable: " + $publishManifest.Error
  Write-Output ("publish manifest error: " + $publishManifest.Error)
}

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
$installedDistCount = if ($installedPkg) { Count-Files (Join-Path $installedPkg "dist") } else { -1 }
Assert-Check "installed src tree mirrors the published package" ($publishManifest.Ok -and $installedSrcCount -eq $expectedSrcCount) "installed=$installedSrcCount published=$expectedSrcCount $publishManifestNote"
Assert-Check "installed test tree mirrors the published package" ($publishManifest.Ok -and $installedTestCount -eq $expectedTestCount) "installed=$installedTestCount published=$expectedTestCount $publishManifestNote"
Assert-Check "installed docs tree mirrors the published package" ($publishManifest.Ok -and $installedDocsCount -eq $expectedDocsCount) "installed=$installedDocsCount published=$expectedDocsCount $publishManifestNote"
Assert-Check "installed dist tree mirrors the published package" ($publishManifest.Ok -and $installedDistCount -eq $expectedDistCount) "installed=$installedDistCount published=$expectedDistCount $publishManifestNote"

# --- host registration ---------------------------------------------------------------
$hostConfigPath = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
$hostConfig = if (Test-Path $hostConfigPath) {
  Get-Content $hostConfigPath -Raw -Encoding UTF8
} else { "" }
Assert-Check "plugin registered in opencode.json" ($hostConfig.Contains($PluginId))

# --- headless server behavior check ------------------------------------------------
# test/install-verify.ts loads src/index.ts exactly as the server would and drives
# setup() with a mock context (RPC on/off, retry hook, cleanup). Run from the repo
# root so relative imports resolve. Exit 0 + "PASSED" = the server chain works.
$headlessOutput = (node --experimental-strip-types (Join-Path $repoRoot "test\install-verify.ts") 2>&1 | Out-String).Trim()
Assert-Check "headless server behavior (install-verify.ts)" ($headlessOutput.Contains("HEADLESS INSTALL VERIFICATION PASSED")) "exit=$LASTEXITCODE"

Write-Output "----"
if ($script:failures -eq 0) {
  Write-Output ("VERIFY OK — v$expectedVersion @ $localHead fully installed")
  exit 0
}
Write-Output ("VERIFY FAILED — $script:failures check(s) failed")
exit 1