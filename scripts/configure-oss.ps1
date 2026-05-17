param(
  [Parameter(Mandatory = $true)]
  [string]$Bucket,
  [string]$Prefix = "gamedraft/dvc",
  [string]$Endpoint = "https://oss-cn-hangzhou.aliyuncs.com"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
. (Join-Path $PSScriptRoot "oss-hydrate-env.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
& (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
$Python = Join-Path $Root ".tools\Python311\python.exe"

Sync-OssEnvUserToProcess
Assert-OssCredentialsInProcess
$KeyId = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
$KeySecret = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")

Push-Location $Root
try {
  Invoke-OssWithoutProxy {
    & $Python -m dvc remote modify aliyun_oss url "oss://$Bucket/$Prefix"
    & $Python -m dvc remote modify aliyun_oss oss_endpoint $Endpoint
    & $Python -m dvc remote modify --local aliyun_oss oss_key_id $KeyId
    & $Python -m dvc remote modify --local aliyun_oss oss_key_secret $KeySecret
    & $Python -m dvc remote list
  }
}
finally {
  Pop-Location
}
