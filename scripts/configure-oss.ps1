param(
  [Parameter(Mandatory = $true)]
  [string]$Bucket,
  [string]$Prefix = "gamedraft/dvc",
  [string]$Endpoint = "https://oss-cn-hangzhou.aliyuncs.com",
  [string]$KeyId = $env:OSS_ACCESS_KEY_ID,
  [string]$KeySecret = $env:OSS_ACCESS_KEY_SECRET
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
& (Join-Path $PSScriptRoot "bootstrap-dvc.ps1")
$Python = Join-Path $Root ".tools\Python311\python.exe"

Push-Location $Root
try {
  Invoke-WithoutProxy {
    & $Python -m dvc remote modify aliyun_oss url "oss://$Bucket/$Prefix"
    & $Python -m dvc remote modify aliyun_oss oss_endpoint $Endpoint
    if ($KeyId) { & $Python -m dvc remote modify --local aliyun_oss oss_key_id $KeyId }
    if ($KeySecret) { & $Python -m dvc remote modify --local aliyun_oss oss_key_secret $KeySecret }
    & $Python -m dvc remote list
  }
}
finally {
  Pop-Location
}
