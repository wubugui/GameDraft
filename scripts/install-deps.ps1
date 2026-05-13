param(
  [switch]$SkipDvcPull
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
& (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
$Python = Join-Path $Root ".tools\Python311\python.exe"

if (-not $SkipDvcPull) {
  $script:__installDepsSyncExit = 0
  Invoke-WithoutProxy {
    & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull "resources/vendor_archives.dvc"
    $script:__installDepsSyncExit = $LASTEXITCODE
    if ($script:__installDepsSyncExit -ne 0) {
      return
    }
    & $Python -m dvc checkout "resources/vendor_archives.dvc"
    $script:__installDepsSyncExit = $LASTEXITCODE
  }
  if ($script:__installDepsSyncExit -eq 2) {
    throw "GameDraftOssCredentialError"
  }
  if ($script:__installDepsSyncExit -ne 0) {
    throw "GameDraftInstallDepsFailed:sync_or_checkout:$($script:__installDepsSyncExit)"
  }
}

$Vendor = Join-Path $Root "resources\vendor_archives"
$NodeZip = Join-Path $Vendor "node-portable-win-x64.zip"
$NodeModulesZip = Join-Path $Vendor "node_modules.zip"
$WheelhouseZip = Join-Path $Vendor "python-wheelhouse-py311.zip"

if (Test-Path $NodeZip) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Root ".tools\node-portable") | Out-Null
  Expand-Archive -LiteralPath $NodeZip -DestinationPath (Join-Path $Root ".tools\node-portable") -Force
}

if (Test-Path $NodeModulesZip) {
  if (Test-Path (Join-Path $Root "node_modules")) {
    Remove-Item -LiteralPath (Join-Path $Root "node_modules") -Recurse -Force
  }
  Expand-Archive -LiteralPath $NodeModulesZip -DestinationPath $Root -Force
}

if (Test-Path $WheelhouseZip) {
  $Wheelhouse = Join-Path $Root ".tools\wheelhouse_py311"
  if (Test-Path $Wheelhouse) {
    Remove-Item -LiteralPath $Wheelhouse -Recurse -Force
  }
  Expand-Archive -LiteralPath $WheelhouseZip -DestinationPath (Join-Path $Root ".tools") -Force
  & $Python -m pip install --no-index --find-links $Wheelhouse -c (Join-Path $Root "config\python-deps-constraints.txt") dvc dvc-oss
  if ($LASTEXITCODE -ne 0) {
    throw "GameDraftInstallDepsFailed:pip_dvc:$LASTEXITCODE"
  }
  & $Python -m pip install --no-index --find-links $Wheelhouse -r (Join-Path $Root "tools\editor\requirements.txt")
  if ($LASTEXITCODE -ne 0) {
    throw "GameDraftInstallDepsFailed:pip_editor:$LASTEXITCODE"
  }
}

Write-Host "Dependencies installed."
