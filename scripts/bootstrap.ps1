param(
  [ValidateSet("", "game", "editor", "clean")]
  [string]$Action = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
Initialize-BootstrapProcessWithoutProxy

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

  if ($KeyId -and $KeySecret) {
    Write-Host "OSS credentials: ready"
    return
  }

  Write-Host "OSS credentials are missing. They will be saved to your Windows user environment."
  if (-not $KeyId) {
    $KeyId = Read-Host "OSS_ACCESS_KEY_ID"
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $KeyId, "User")
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $KeyId, "Process")
  }
  if (-not $KeySecret) {
    $SecretSecure = Read-Host "OSS_ACCESS_KEY_SECRET" -AsSecureString
    $KeySecret = ConvertFrom-SecureStringPlainText $SecretSecure
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $KeySecret, "User")
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $KeySecret, "Process")
  }

  Write-Host "OSS credentials: saved"
}

function Test-DependenciesReady {
  $Node = Join-Path $Root ".tools\node-portable\node-v22.14.0-win-x64\npm.cmd"
  $NodeModules = Join-Path $Root "node_modules"
  if (-not (Test-Path $Node)) { return $false }
  if (-not (Test-Path $NodeModules)) { return $false }
  if (-not (Test-Path $Python)) { return $false }

  & $Python -c "import dvc, oss2, yaml, PySide6, numpy, cv2, PIL" *> $null
  return ($LASTEXITCODE -eq 0)
}

function Ensure-Dependencies {
  if (Test-DependenciesReady) {
    Write-Host "Third-party dependencies: ready"
    return
  }

  Write-Host "Third-party dependencies: missing or incomplete, installing..."
  Invoke-RepoScript "install-deps.ps1"
}

function Pull-DvcTarget {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Target
  )

  Invoke-OssWithoutProxy {
    & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull $Target
    & $Python -m dvc checkout $Target
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
