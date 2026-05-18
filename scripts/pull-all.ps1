param(
  [switch]$Editor,
  [switch]$Vendor,
  [string]$GitProxy = ''
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
. (Join-Path $PSScriptRoot "oss-hydrate-env.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $Root
try {
  Mask-GameDraftProxyEnvironmentProcess
  Invoke-GameDraftGitWithTemporaryProxy -ProxyUrl $GitProxy pull

  & (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
  Assert-OssCredentialsInProcess
  $Python = Join-Path $Root ".tools\Python311\python.exe"
  Invoke-OssWithoutProxy {
    & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull "public/resources/runtime.dvc"
    & $Python -m dvc checkout "public/resources/runtime.dvc"
    if ($Editor) {
      & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull "resources/editor_projects.dvc"
      & $Python -m dvc checkout "resources/editor_projects.dvc"
    }
    if ($Vendor) {
      & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") pull "resources/vendor_archives.dvc"
      & $Python -m dvc checkout "resources/vendor_archives.dvc"
    }
  }
}
finally {
  Pop-Location
}
