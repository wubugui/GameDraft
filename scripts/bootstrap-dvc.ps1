param(
  [string]$BaseUrl = $env:GAMEDRAFT_BOOTSTRAP_BASE_URL
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "no-proxy.ps1")
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ToolsDir = Join-Path $Root ".tools"
$PythonDir = Join-Path $ToolsDir "Python311"
$PythonExe = Join-Path $PythonDir "python.exe"

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

  Write-Host "Downloading DVC portable runtime from $Url"
  try {
    Invoke-WithoutProxy { Invoke-WebRequest -Uri $Url -OutFile $Archive }
  }
  catch {
    $reason = $_.Exception.Message
    Write-Host "Portable runtime download failed: $reason"
    Write-Host ""
    Write-Host "[This step] Anonymous HTTP GET to the ZIP URL. OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET are NOT sent and do NOT sign this request."
    Write-Host "[403/401 meaning] The server refused unauthenticated read: wrong URL, object missing, bucket policy blocking public read, CDN/WAF, or network/proxy — not 'wrong RAM secret' for this download."
    Write-Host ""
    $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
    $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")
    $idLen = if ($kid) { $kid.Length } else { 0 }
    $secLen = if ($ks) { $ks.Length } else { 0 }
    Write-Host "[Later steps only] install-deps / sync-dvc-cache will read RAM keys from this process. Current process (values never printed):"
    Write-Host ("  OSS_ACCESS_KEY_ID: {0}" -f $(if ($idLen -gt 0) { "set, length $idLen (typical Aliyun AccessKeyId is often 16+ chars, e.g. LTAI...)" } else { "not set" }))
    Write-Host ("  OSS_ACCESS_KEY_SECRET: {0}" -f $(if ($secLen -gt 0) { "set, length $secLen (typical secret is 30 chars or longer)" } else { "not set" }))
    if ($idLen -gt 0 -and $idLen -lt 12) {
      Write-Host "  Note: ID length looks like a placeholder; it still does NOT cause this ZIP 403. Fix anonymous access to the URL or place the zip under resources\vendor_archives\$ArchiveName offline."
    }
    Write-Host ""
    Write-Host "[本步骤] 使用匿名 HTTP 下载 ZIP，不会携带 RAM 密钥，也不会用密钥签名；本步骤的 403 不是“Secret 填错”。"
    Write-Host "[后面步骤] 安装依赖与 DVC 拉缓存才会用到 OSS_ACCESS_KEY_*；上面“长度”只说明变量是否已写入当前进程，不解释本次 403。"
    Write-Host "[可选] 将 $ArchiveName 放到仓库 resources\vendor_archives\ 下可跳过本下载。"
    Write-Host ""
    throw "GameDraftBootstrapHttpDownloadError: anonymous GET failed (see messages above; not RAM key signing for this ZIP)."
  }
}

Write-Host "Extracting $ArchiveName"
Expand-Archive -LiteralPath $Archive -DestinationPath $ToolsDir -Force

if (-not (Test-Path $PythonExe)) {
  throw "DVC portable runtime did not extract to .tools/Python311."
}

& $PythonExe -m dvc --version
