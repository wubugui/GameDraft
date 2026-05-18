$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
. (Join-Path $PSScriptRoot "oss-hydrate-env.ps1")

$InitialProxyEnvironment = Get-GameDraftProxyEnvironmentSnapshot
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $Root
try {
  & (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
  Assert-OssCredentialsInProcess
  $Python = Join-Path $Root ".tools\Python311\python.exe"

  Invoke-OssWithoutProxy {
    & $Python -m dvc status
    & $Python (Join-Path $PSScriptRoot "sync-dvc-cache.py") push "public/resources/runtime.dvc" "resources/editor_projects.dvc" "resources/vendor_archives.dvc"
  }

  # Git remote: explicitly restore the process proxy env captured at script startup.
  # This keeps GitHub traffic on the user's proxy without touching User/Machine env or git config.
  Set-GameDraftProxyEnvironmentProcess -Snapshot $InitialProxyEnvironment
  git push
}
finally {
  Pop-Location
}
