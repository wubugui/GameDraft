param(
  [string]$Bucket = "gamedraft-assets",
  [string]$Endpoint = "https://oss-cn-shanghai.aliyuncs.com",
  [string]$Prefix = "gamedraft/bootstrap",
  [string]$ArchiveName = "python311-dvc-win-x64.zip"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $Root ".tools\Python311\python.exe"
$Archive = Join-Path $Root "resources\vendor_archives\$ArchiveName"
$Key = $Prefix.TrimEnd("/") + "/" + $ArchiveName

Invoke-WithoutProxy {
  & $Python (Join-Path $PSScriptRoot "upload-bootstrap.py") --bucket $Bucket --endpoint $Endpoint --file $Archive --key $Key
}
