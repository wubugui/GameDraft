param(
  [switch]$InstallDeps
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
. (Join-Path $PSScriptRoot "oss-hydrate-env.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
& (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
Assert-OssCredentialsInProcess
$Python = Join-Path $Root ".tools\Python311\python.exe"
Invoke-OssWithoutProxy {
  & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull "public/resources/runtime.dvc"
  & $Python -m dvc checkout "public/resources/runtime.dvc"
}
if ($InstallDeps) {
  & (Join-Path $PSScriptRoot "install-deps.ps1")
}
Write-Host "Runtime resources are ready."
