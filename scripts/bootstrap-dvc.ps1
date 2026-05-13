param(
  [string]$BaseUrl = $env:GAMEDRAFT_BOOTSTRAP_BASE_URL
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
. (Join-Path $PSScriptRoot "oss-hydrate-env.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ToolsDir = Join-Path $Root ".tools"
$PythonDir = Join-Path $ToolsDir "Python311"
$PythonExe = Join-Path $PythonDir "python.exe"

function Get-OssVirtualHostBucketAndObjectKey {
  param([Parameter(Mandatory = $true)][Uri]$Uri)

  $hostName = $Uri.Host
  $m = [regex]::Match($hostName, '^(?<bucket>[^.]+)\.(?<suffix>oss-.+\.aliyuncs\.com)$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $m.Success) {
    return $null
  }
  $bucket = $m.Groups["bucket"].Value
  $path = $Uri.AbsolutePath.TrimStart("/")
  if (-not $path) {
    throw "OSS URL has no object path: $Uri"
  }
  $objectKey = [Uri]::UnescapeDataString($path)
  return @{ Bucket = $bucket; ObjectKey = $objectKey }
}

function Get-OssPathStyleBucketAndObjectKey {
  param([Parameter(Mandatory = $true)][Uri]$Uri)

  $hostName = $Uri.Host
  if ($hostName -notmatch '^oss-.+\.aliyuncs\.com$') {
    return $null
  }
  $segments = @($Uri.AbsolutePath.Trim("/").Split([char[]]'/', [StringSplitOptions]::RemoveEmptyEntries))
  if ($segments.Count -lt 2) {
    return $null
  }
  $bucket = $segments[0]
  $objectKey = ($segments[1..($segments.Count - 1)] -join "/")
  $objectKey = [Uri]::UnescapeDataString($objectKey)
  return @{ Bucket = $bucket; ObjectKey = $objectKey }
}

function Invoke-OssSignedObjectGet {
  param(
    [Parameter(Mandatory = $true)][string]$UriString,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [Parameter(Mandatory = $true)][string]$AccessKeyId,
    [Parameter(Mandatory = $true)][string]$AccessKeySecret
  )

  $uri = [Uri]$UriString
  $parsed = Get-OssVirtualHostBucketAndObjectKey -Uri $uri
  if (-not $parsed) {
    $parsed = Get-OssPathStyleBucketAndObjectKey -Uri $uri
  }
  if (-not $parsed) {
    throw "Cannot derive bucket/object key for OSS signing from URL: $UriString (expected virtual host https://bucket.oss-cn-xxx.aliyuncs.com/key or path-style https://oss-cn-xxx.aliyuncs.com/bucket/key)."
  }

  $bucket = $parsed.Bucket
  $objectKey = $parsed.ObjectKey
  $canonicalResource = "/$bucket/$objectKey"
  $dateGmt = (Get-Date).ToUniversalTime().ToString("ddd, dd MMM yyyy HH:mm:ss \G\M\T", [Globalization.CultureInfo]::InvariantCulture)
  $stringToSign = "GET`n`n`n$dateGmt`n$canonicalResource"

  $hmac = New-Object System.Security.Cryptography.HMACSHA1
  try {
    $hmac.Key = [Text.Encoding]::UTF8.GetBytes($AccessKeySecret)
    $sig = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($stringToSign)))
  }
  finally {
    $hmac.Dispose()
  }

  $auth = "OSS ${AccessKeyId}:$sig"
  Invoke-WebRequest -Uri $UriString -OutFile $OutFile -Headers @{
    "Date"            = $dateGmt
    "Authorization"   = $auth
  }
}

if (Test-Path $PythonExe) {
  & $PythonExe -m dvc --version
  exit $LASTEXITCODE
}

$ConfigPath = Join-Path $Root "config\bootstrap-oss.json"
$ExampleConfigPath = Join-Path $Root "config\bootstrap-oss.example.json"
if (-not $BaseUrl) {
  foreach ($path in @($ConfigPath, $ExampleConfigPath)) {
    if (Test-Path $path) {
      $Config = Get-Content $path -Raw | ConvertFrom-Json
      $BaseUrl = [string]$Config.baseUrl
      if ($BaseUrl) { break }
    }
  }
}

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
$CacheDir = Join-Path $Root ".cache\bootstrap"
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

$ArchiveName = "python311-dvc-win-x64.zip"
$Archive = Join-Path $Root "resources\vendor_archives\$ArchiveName"
if (-not (Test-Path $Archive)) {
  if (-not $BaseUrl) {
    throw "Missing bootstrap OSS URL. Ensure config/bootstrap-oss.example.json exists with baseUrl, copy it to config/bootstrap-oss.json for overrides, or set GAMEDRAFT_BOOTSTRAP_BASE_URL."
  }
  $Archive = Join-Path $CacheDir $ArchiveName
  $Url = $BaseUrl.TrimEnd("/") + "/" + $ArchiveName

  Sync-OssEnvUserToProcess
  $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
  $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")

  if ($kid -and $ks) {
    Write-Host "Downloading DVC portable runtime (OSS RAM signed GET) from $Url"
    try {
      Invoke-WithoutProxy { Invoke-OssSignedObjectGet -UriString $Url -OutFile $Archive -AccessKeyId $kid -AccessKeySecret $ks }
    }
    catch {
      $reason = $_.Exception.Message
      Write-Host "Portable runtime download failed (signed OSS): $reason"
      Write-Host "This request used OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET (HMAC-SHA1 Authorization). 403/SignatureDoesNotMatch usually means wrong keys, wrong clock (GMT), missing oss:GetObject on this object, or URL/bucket mismatch."
      Write-Host ("Process env (values not printed): OSS_ACCESS_KEY_ID length {0}; OSS_ACCESS_KEY_SECRET length {1}." -f $kid.Length, $ks.Length)
      Write-Host "[中文] 本步已带 RAM 签名访问对象；若仍失败请核对 AccessKey、RAM 是否对该 Bucket 前缀有读权限、本机 UTC 时间是否正确。"
      throw "GameDraftBootstrapHttpDownloadError: signed OSS GET failed (check RAM policy and keys)."
    }
  }
  else {
    Write-Host "Downloading DVC portable runtime (anonymous HTTP GET) from $Url"
    Write-Host "No OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET in this process: private buckets will return 403; set keys first (GameDraft bootstrap menu already asks before this step)."
    try {
      Invoke-WithoutProxy { Invoke-WebRequest -Uri $Url -OutFile $Archive }
    }
    catch {
      $reason = $_.Exception.Message
      Write-Host "Portable runtime download failed (anonymous): $reason"
      Write-Host "Private OSS buckets disallow anonymous reads. Run bootstrap.ps1 so credentials are collected first, or set OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET on this process."
      Write-Host "[中文] 当前为匿名下载；若 Bucket 禁止匿名读，请先在引导里填写 RAM 密钥（或导出环境变量）后再执行本脚本。"
      throw "GameDraftBootstrapHttpDownloadError: anonymous GET failed (private bucket needs RAM keys on this process)."
    }
  }
}

Write-Host "Extracting $ArchiveName"
Expand-Archive -LiteralPath $Archive -DestinationPath $ToolsDir -Force

if (-not (Test-Path $PythonExe)) {
  throw "DVC portable runtime did not extract to .tools/Python311."
}

& $PythonExe -m dvc --version
