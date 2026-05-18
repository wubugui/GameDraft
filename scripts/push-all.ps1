param([string]$GitProxy = '')

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
. (Join-Path $PSScriptRoot "oss-hydrate-env.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $Root
try {
  Mask-GameDraftProxyEnvironmentProcess
  & (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
  Assert-OssCredentialsInProcess
  $Python = Join-Path $Root ".tools\Python311\python.exe"

  Invoke-OssWithoutProxy {
    & $Python -m dvc status
    & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") push "public/resources/runtime.dvc" "resources/editor_projects.dvc" "resources/vendor_archives.dvc"
  }

  Invoke-GameDraftGitWithTemporaryProxy -ProxyUrl $GitProxy push
}
finally {
  Pop-Location
}
