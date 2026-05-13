param(
  [ValidateSet("", "game", "editor", "clean", "oss")]
  [string]$Action = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
. (Join-Path $PSScriptRoot "oss-hydrate-env.ps1")

$script:MaxOssCredentialRetries = 5
$script:SetxMaxCombinedChars = 900

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
  Write-Host ('Diagnostic — values not printed — process OSS_ACCESS_KEY_ID {0}; OSS_ACCESS_KEY_SECRET {1}. User-profile ID {2}; Secret {3}.' -f @(
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

  $ossZipAttempt = 0
  while ($true) {
    Write-Host "Local Python runtime: missing, downloading bootstrap runtime..."
    try {
      Invoke-RepoScript "bootstrap-dvc.ps1"
      if ($LASTEXITCODE -ne 0) {
        throw ('bootstrap-dvc.ps1 exited with code ' + $LASTEXITCODE + '; portable Python or DVC self-check failed.')
      }
      if (-not (Test-Path $Python)) {
        throw ('bootstrap-dvc.ps1 finished but portable Python is still missing at: ' + $Python)
      }
      return
    }
    catch {
      if ($_.Exception.Message -like "*GameDraftBootstrapHttpDownloadError*") {
        $ossZipAttempt++
        if ($ossZipAttempt -ge $script:MaxOssCredentialRetries) {
          throw ('Exceeded ' + $script:MaxOssCredentialRetries + ' attempts to download portable Python after OSS issues. Fix RAM policy, base URL, or place python311-dvc-win-x64.zip under resources\vendor_archives\.')
        }
        Write-Host 'Portable runtime download failed after signed or anonymous OSS GET. For a private bucket, wrong RAM keys or missing oss:GetObject on the ZIP path often causes this; re-enter credentials.'
        Write-OssCredentialPassingDiagnostics
        Ensure-OssCredentials -ForceReenter
        continue
      }
      throw
    }
  }
}

function Ensure-OssCredentials {
  param([switch]$ForceReenter)

  if ($ForceReenter) {
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $null, "Process")
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $null, "Process")
    Write-Host "OSS refused access or the AccessKey is invalid. Enter OSS credentials again."
  }
  else {
    Sync-OssEnvUserToProcess
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

  if ($null -ne $KeyId) {
    $KeyId = $KeyId.Trim()
  }
  if ($null -ne $KeySecret) {
    $KeySecret = $KeySecret.Trim()
  }
  if ([string]::IsNullOrWhiteSpace($KeyId) -or [string]::IsNullOrWhiteSpace($KeySecret)) {
    throw "OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET must be non-empty after input."
  }

  $PersistAnswer = Read-Host "Save OSS credentials to your Windows user environment for future sessions? [y/N]"
  $Persist = $PersistAnswer -match "^\s*[Yy]"

  if ($Persist) {
    $combinedLen = $KeyId.Length + $KeySecret.Length
    if ($combinedLen -ge $script:SetxMaxCombinedChars) {
      Write-Host "Credentials are long for reliable setx; persisting with User environment API instead."
      [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $KeyId, "User")
      [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $KeySecret, "User")
      Write-Host 'OSS credentials: saved to user environment — User scope; open a new terminal to pick up changes outside this script.'
    }
    else {
      $null = & setx OSS_ACCESS_KEY_ID "$KeyId"
      $sxId = $LASTEXITCODE
      $null = & setx OSS_ACCESS_KEY_SECRET "$KeySecret"
      $sxSec = $LASTEXITCODE
      if ($sxId -eq 0 -and $sxSec -eq 0) {
        Write-Host 'OSS credentials: saved with setx — user environment; open a new terminal to pick up changes outside this script.'
      }
      else {
        Write-Host ('setx failed; exit codes ' + $sxId + ' / ' + $sxSec + '. Persisting with User environment API instead.')
        [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $KeyId, "User")
        [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $KeySecret, "User")
        Write-Host 'OSS credentials: saved to user environment — User scope; open a new terminal to pick up changes outside this script.'
      }
    }
  }
  else {
    Write-Host "OSS credentials: process only — this session only; not written to user profile."
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

  $vendorDir = Join-Path $Root "resources\vendor_archives"
  $wheelhouseDir = Join-Path $Root ".tools\wheelhouse_py311"
  $hasVendorSidecar = $false
  if (Test-Path $wheelhouseDir) {
    $hasVendorSidecar = $true
  }
  elseif (Test-Path $vendorDir) {
    $zips = @(Get-ChildItem -LiteralPath $vendorDir -Filter *.zip -File -ErrorAction SilentlyContinue)
    if ($zips.Count -gt 0) {
      $hasVendorSidecar = $true
    }
  }
  if (-not $hasVendorSidecar) {
    return $false
  }

  & $Python -c "import dvc, oss2, yaml, PySide6" *> $null
  return ($LASTEXITCODE -eq 0)
}

function Ensure-Dependencies {
  if (Test-DependenciesReady) {
    Write-Host "Third-party dependencies: ready"
    return
  }

  Write-Host "Third-party dependencies: missing or incomplete, installing..."
  $ossAttempt = 0
  while ($true) {
    try {
      Invoke-RepoScript "install-deps.ps1"
      break
    }
    catch {
      if ($_.Exception.Message -eq "GameDraftOssCredentialError" -or $_.Exception.Message -like "GameDraftOssCredentialError*") {
        $ossAttempt++
        if ($ossAttempt -ge $script:MaxOssCredentialRetries) {
          throw ('Exceeded ' + $script:MaxOssCredentialRetries + ' OSS credential retries during dependency install. Fix RAM keys or policy, then run bootstrap again.')
        }
        Write-Host 'OSS access was denied or the AccessKey is invalid; sync-dvc-cache exited with code 2. See stderr above for the OSS exception.'
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

  $ossAttempt = 0
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
        $ossAttempt++
        if ($ossAttempt -ge $script:MaxOssCredentialRetries) {
          throw ('Exceeded ' + $script:MaxOssCredentialRetries + ' OSS credential retries while pulling ' + $Target + '. Fix RAM keys or policy, then run bootstrap again.')
        }
        Write-Host ('OSS access was denied or the AccessKey is invalid while pulling ' + $Target + '; sync-dvc-cache exited with code 2. See stderr above.')
        Write-OssCredentialPassingDiagnostics
        Ensure-OssCredentials -ForceReenter
        continue
      }
      throw
    }
  }
}

function Initialize-OssCredentialsOnly {
  Write-Host ""
  Write-Host "Re-configure OSS RAM credentials: clearing process-scoped keys, then enter ID and Secret again."
  Write-Host "User-profile keys are not removed; choose persist Y to overwrite them with the new pair."
  Ensure-OssCredentials -ForceReenter
  Write-Host "OSS reconfiguration finished; this session process is updated."
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
  Write-Host "4. Re-configure OSS RAM credentials only"
  Write-Host "0. Exit"
  Write-Host ""
}

function Invoke-Action {
  param([Parameter(Mandatory = $true)][string]$SelectedAction)

  switch ($SelectedAction) {
    "game" { Initialize-Game }
    "editor" { Initialize-Editor }
    "clean" { Clean-LocalEnvironment }
    "oss" { Initialize-OssCredentialsOnly }
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
    "4" { Initialize-OssCredentialsOnly }
    "0" { exit 0 }
    default { Write-Host "Unknown selection." }
  }
}
