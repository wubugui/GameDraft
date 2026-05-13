param(
  [ValidateSet("", "game", "editor", "clean")]
  [string]$Action = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $Root ".tools\Python311\python.exe"

function Invoke-RepoScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [string[]]$Arguments = @()
  )

  & (Join-Path $PSScriptRoot $Name) @Arguments
}

function Write-OssCredentialPassingDiagnostics {
  $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
  $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")
  $ukid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "User")
  $uks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "User")
  Write-Host ("Diagnostic (values are never printed): process OSS_ACCESS_KEY_ID {0}; OSS_ACCESS_KEY_SECRET {1}. User-profile ID {2}; Secret {3}." -f @(
      $(if ($kid) { "set, length $($kid.Length)" } else { "not set" }),
      $(if ($ks) { "set, length $($ks.Length)" } else { "not set" }),
      $(if ($ukid) { "set" } else { "not set" }),
      $(if ($uks) { "set" } else { "not set" })
    ))
}

function ConvertFrom-SecureStringPlainText {
  param([Parameter(Mandatory = $true)][securestring]$Value)

  $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
  }
}

function Ensure-LocalPython {
  if (Test-Path $Python) {
    Write-Host "Local Python runtime: ready"
    return
  }

  Write-Host "Local Python runtime: missing, downloading bootstrap runtime..."
  Invoke-RepoScript "bootstrap-dvc.ps1"
}

function Ensure-OssCredentials {
  param([switch]$ForceReenter)

  if ($ForceReenter) {
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $null, "Process")
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $null, "Process")
    Write-Host "OSS refused access or the AccessKey is invalid. Enter OSS credentials again."
  }
  else {
    $KeyId = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
    if (-not $KeyId) {
      $KeyId = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "User")
      if ($KeyId) {
        [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $KeyId, "Process")
      }
    }

    $KeySecret = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")
    if (-not $KeySecret) {
      $KeySecret = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "User")
      if ($KeySecret) {
        [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $KeySecret, "Process")
      }
    }
  }

  $KeyId = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
  $KeySecret = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")

  if ($KeyId -and $KeySecret) {
    Write-Host "OSS credentials: ready"
    return
  }

  if (-not $KeyId) {
    if (-not $ForceReenter) {
      Write-Host "OSS credentials are missing. Portable artifacts and dependency sync use OSS; enter values for this session."
    }
    $KeyId = Read-Host "OSS_ACCESS_KEY_ID"
  }
  if (-not $KeySecret) {
    $SecretSecure = Read-Host "OSS_ACCESS_KEY_SECRET" -AsSecureString
    $KeySecret = ConvertFrom-SecureStringPlainText $SecretSecure
  }

  $PersistAnswer = Read-Host "Save OSS credentials to your Windows user environment for future sessions? [y/N]"
  $Persist = $PersistAnswer -match "^\s*[Yy]"

  if ($Persist) {
    $null = & setx OSS_ACCESS_KEY_ID "$KeyId"
    if ($LASTEXITCODE -ne 0) {
      throw "setx OSS_ACCESS_KEY_ID failed with exit $LASTEXITCODE"
    }
    $null = & setx OSS_ACCESS_KEY_SECRET "$KeySecret"
    if ($LASTEXITCODE -ne 0) {
      throw "setx OSS_ACCESS_KEY_SECRET failed with exit $LASTEXITCODE"
    }
    Write-Host "OSS credentials: saved with setx (user environment; open a new terminal to pick up changes outside this script)."
  }
  else {
    Write-Host "OSS credentials: process only (this session; not written to user profile)."
  }

  [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $KeyId, "Process")
  [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $KeySecret, "Process")
}

function Test-DependenciesReady {
  $Node = Join-Path $Root ".tools\node-portable\node-v22.14.0-win-x64\npm.cmd"
  $NodeModules = Join-Path $Root "node_modules"
  if (-not (Test-Path $Node)) { return $false }
  if (-not (Test-Path $NodeModules)) { return $false }
  if (-not (Test-Path $Python)) { return $false }

  & $Python -c "import dvc, oss2, yaml, PySide6" *> $null
  return ($LASTEXITCODE -eq 0)
}

function Ensure-Dependencies {
  if (Test-DependenciesReady) {
    Write-Host "Third-party dependencies: ready"
    return
  }

  Write-Host "Third-party dependencies: missing or incomplete, installing..."
  while ($true) {
    try {
      Invoke-RepoScript "install-deps.ps1"
      break
    }
    catch {
      if ($_.Exception.Message -eq "GameDraftOssCredentialError" -or $_.Exception.Message -like "GameDraftOssCredentialError*") {
        Write-Host "OSS access was denied or the AccessKey is invalid (sync-dvc-cache exit 2). Check stderr above for the OSS exception."
        Write-OssCredentialPassingDiagnostics
        Ensure-OssCredentials -ForceReenter
        continue
      }
      throw
    }
  }
}

function Pull-DvcTarget {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Target
  )

  while ($true) {
    try {
      $script:__pullSyncExit = 0
      Invoke-WithoutProxy {
        & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull $Target
        $script:__pullSyncExit = $LASTEXITCODE
        if ($script:__pullSyncExit -ne 0) {
          return
        }
        & $Python -m dvc checkout $Target
        $script:__pullSyncExit = $LASTEXITCODE
      }
      if ($script:__pullSyncExit -eq 2) {
        throw "GameDraftOssCredentialError"
      }
      if ($script:__pullSyncExit -ne 0) {
        throw "GameDraftPullFailed:sync_or_checkout:$($script:__pullSyncExit)"
      }
      return
    }
    catch {
      if ($_.Exception.Message -eq "GameDraftOssCredentialError" -or $_.Exception.Message -like "GameDraftOssCredentialError*") {
        Write-Host "OSS access was denied or the AccessKey is invalid while pulling $Target (sync-dvc-cache exit 2). Check stderr above."
        Write-OssCredentialPassingDiagnostics
        Ensure-OssCredentials -ForceReenter
        continue
      }
      throw
    }
  }
}

function Initialize-Game {
  Push-Location $Root
  try {
    Ensure-OssCredentials
    Ensure-LocalPython
    Ensure-Dependencies
    Write-Host "Runtime resources: syncing..."
    Pull-DvcTarget "public/resources/runtime.dvc"
    Write-Host "Game initialization complete."
  }
  finally {
    Pop-Location
  }
}

function Initialize-Editor {
  Push-Location $Root
  try {
    Ensure-OssCredentials
    Ensure-LocalPython
    Ensure-Dependencies
    Write-Host "Runtime resources: syncing..."
    Pull-DvcTarget "public/resources/runtime.dvc"
    Write-Host "Editor project resources: syncing..."
    Pull-DvcTarget "resources/editor_projects.dvc"
    Write-Host "Editor initialization complete."
  }
  finally {
    Pop-Location
  }
}

function Remove-RepoPath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  $Target = Join-Path $Root $RelativePath
  if (-not (Test-Path $Target)) {
    return
  }

  $ResolvedRoot = [System.IO.Path]::GetFullPath($Root)
  $ResolvedTarget = [System.IO.Path]::GetFullPath($Target)
  if (-not $ResolvedTarget.StartsWith($ResolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean path outside repo: $ResolvedTarget"
  }

  Write-Host "Removing $RelativePath"
  Remove-Item -LiteralPath $ResolvedTarget -Recurse -Force
}

function Clean-LocalEnvironment {
  Push-Location $Root
  try {
    Write-Host "Clean removes local fetched resources, dependency installs, build output, and DVC cache."
    Write-Host "It does not remove Git-tracked code or your saved OSS credentials."
    $Confirm = Read-Host "Type CLEAN to continue"
    if ($Confirm -ne "CLEAN") {
      Write-Host "Clean cancelled."
      return
    }

    $Paths = @(
      ".tools",
      "node_modules",
      ".cache",
      ".dvc\cache",
      "dist",
      "public\resources\runtime",
      "resources\editor_projects",
      "resources\vendor_archives"
    )

    foreach ($Path in $Paths) {
      Remove-RepoPath $Path
    }

    Write-Host "Clean complete."
  }
  finally {
    Pop-Location
  }
}

function Show-Menu {
  Write-Host ""
  Write-Host "GameDraft Bootstrap"
  Write-Host "1. Initialize game"
  Write-Host "2. Initialize editor"
  Write-Host "3. Clean local environment"
  Write-Host "0. Exit"
  Write-Host ""
}

function Invoke-Action {
  param([Parameter(Mandatory = $true)][string]$SelectedAction)

  switch ($SelectedAction) {
    "game" { Initialize-Game }
    "editor" { Initialize-Editor }
    "clean" { Clean-LocalEnvironment }
    default { throw "Unknown bootstrap action: $SelectedAction" }
  }
}

if ($Action) {
  Invoke-Action $Action
  exit 0
}

while ($true) {
  Show-Menu
  $Choice = Read-Host "Select"
  switch ($Choice) {
    "1" { Initialize-Game }
    "2" { Initialize-Editor }
    "3" { Clean-LocalEnvironment }
    "0" { exit 0 }
    default { Write-Host "Unknown selection." }
  }
}
