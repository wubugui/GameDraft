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
    Write-Host "This step uses anonymous HTTP GET only (no OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET). If you see 403/401, check the bootstrap base URL, bucket anonymous read policy, or network; it is not RAM key signing for this ZIP."
    $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
    $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")
    Write-Host ("Later install-deps / DVC will need RAM keys on this process: OSS_ACCESS_KEY_ID {0}; OSS_ACCESS_KEY_SECRET {1}." -f @(
        $(if ($kid) { "set ($($kid.Length) chars)" } else { "not set" }),
        $(if ($ks) { "set ($($ks.Length) chars)" } else { "not set" })
      ))
    throw "GameDraftBootstrapHttpDownloadError"
  }
}

Write-Host "Extracting $ArchiveName"
Expand-Archive -LiteralPath $Archive -DestinationPath $ToolsDir -Force

if (-not (Test-Path $PythonExe)) {
  throw "DVC portable runtime did not extract to .tools/Python311."
}

& $PythonExe -m dvc --version
