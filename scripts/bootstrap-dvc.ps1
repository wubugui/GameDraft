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
if (-not $BaseUrl -and (Test-Path $ConfigPath)) {
  $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  $BaseUrl = [string]$Config.baseUrl
}

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
$CacheDir = Join-Path $Root ".cache\bootstrap"
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

$ArchiveName = "python311-dvc-win-x64.zip"
$Archive = Join-Path $Root "resources\vendor_archives\$ArchiveName"
if (-not (Test-Path $Archive)) {
  if (-not $BaseUrl) {
    throw "Missing bootstrap OSS URL. Copy config/bootstrap-oss.example.json to config/bootstrap-oss.json or set GAMEDRAFT_BOOTSTRAP_BASE_URL."
  }
  $Archive = Join-Path $CacheDir $ArchiveName
  $Url = $BaseUrl.TrimEnd("/") + "/" + $ArchiveName

  Write-Host "Downloading DVC portable runtime from $Url"
  Invoke-WithoutProxy { Invoke-WebRequest -Uri $Url -OutFile $Archive }
}

Write-Host "Extracting $ArchiveName"
Expand-Archive -LiteralPath $Archive -DestinationPath $ToolsDir -Force

if (-not (Test-Path $PythonExe)) {
  throw "DVC portable runtime did not extract to .tools/Python311."
}

& $PythonExe -m dvc --version
