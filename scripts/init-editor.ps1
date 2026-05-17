$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
. (Join-Path $PSScriptRoot "oss-hydrate-env.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
& (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
Assert-OssCredentialsInProcess
$Python = Join-Path $Root ".tools\Python311\python.exe"
Invoke-OssWithoutProxy {
  & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull "resources/editor_projects.dvc"
  & $Python -m dvc checkout "resources/editor_projects.dvc"
}
Write-Host "Editor project resources are ready."
