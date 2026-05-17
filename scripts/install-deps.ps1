param(
  [switch]$SkipDvcPull
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
& (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
$Python = Join-Path $Root ".tools\Python311\python.exe"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE"
  }
}

if (-not $SkipDvcPull) {
  Invoke-WithoutProxy {
    & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull "resources/vendor_archives.dvc"
    & $Python -m dvc checkout "resources/vendor_archives.dvc"
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
  Invoke-Checked { & $Python -m pip install --no-index --find-links $Wheelhouse -c (Join-Path $Root "config\python-deps-constraints.txt") dvc dvc-oss } "Installing DVC dependencies"
  Invoke-Checked { & $Python -m pip install --no-index --find-links $Wheelhouse -r (Join-Path $Root "tools\editor\requirements.txt") } "Installing editor dependencies"
}

Write-Host "Dependencies installed."
