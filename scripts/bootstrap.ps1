param(
  [ValidateSet("", "game", "editor", "clean")]
  [string]$Action = ""
)

# Minimal Windows bootstrap: acquire the portable Python runtime (the one
# chicken-and-egg step that cannot run inside Python yet), collect OSS
# credentials into .tools/oss.env, then delegate everything else to the
# cross-platform task runner: python -m tools.dev.
#
# The OSS signed-GET download below is intentionally duplicated from the
# Python port in tools/dev/oss_http.py and frozen — it must keep working
# before any third-party dependency exists.

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ToolsDir = Join-Path $Root ".tools"
$PythonExe = Join-Path $ToolsDir "Python311\python.exe"
$OssEnvFile = Join-Path $ToolsDir "oss.env"
$ArchiveName = "python311-dvc-win-x64.zip"

function Mask-ProxyEnv {
  foreach ($entry in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).GetEnumerator()) {
    $name = [string]$entry.Key
    $lu = $name.ToLowerInvariant()
    if ($lu.EndsWith('_proxy') -or $lu -eq 'no_proxy' -or $lu -eq 'all_proxy' -or ($lu.StartsWith('npm_config_') -and $lu.Contains('proxy'))) {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
  }
  [Environment]::SetEnvironmentVariable('NO_PROXY', '*', 'Process')
  [Environment]::SetEnvironmentVariable('no_proxy', '*', 'Process')
}

function ConvertFrom-SecureStringPlainText {
  param([Parameter(Mandatory = $true)][securestring]$Value)
  $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }
}

function Read-OssEnvFile {
  $result = @{}
  if (Test-Path $OssEnvFile) {
    foreach ($line in Get-Content $OssEnvFile) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
      $idx = $t.IndexOf('=')
      $result[$t.Substring(0, $idx).Trim()] = $t.Substring($idx + 1).Trim()
    }
  }
  return $result
}

function Write-OssEnvFile {
  param([string]$KeyId, [string]$KeySecret)
  New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
  $content = "OSS_ACCESS_KEY_ID=$KeyId`nOSS_ACCESS_KEY_SECRET=$KeySecret`n"
  [System.IO.File]::WriteAllText($OssEnvFile, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Ensure-OssCredentials {
  $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
  $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")
  if ($kid -and $ks) { return }

  $file = Read-OssEnvFile
  if (-not $kid) { $kid = $file["OSS_ACCESS_KEY_ID"] }
  if (-not $ks) { $ks = $file["OSS_ACCESS_KEY_SECRET"] }

  # Legacy User-scope env (older installs); migrate into .tools/oss.env below.
  if (-not $kid) { $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "User") }
  if (-not $ks) { $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "User") }

  if (-not $kid -or -not $ks) {
    Write-Host "OSS credentials are missing. They will be saved to .tools/oss.env."
    if (-not $kid) { $kid = Read-Host "OSS_ACCESS_KEY_ID" }
    if (-not $ks) {
      $secure = Read-Host "OSS_ACCESS_KEY_SECRET" -AsSecureString
      $ks = ConvertFrom-SecureStringPlainText $secure
    }
  }

  if ($kid -and $ks) {
    Write-OssEnvFile -KeyId $kid -KeySecret $ks
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $kid, "Process")
    [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $ks, "Process")
    Write-Host "OSS credentials: saved to .tools/oss.env"
  }
}

function Get-BootstrapBaseUrl {
  $u = $env:GAMEDRAFT_BOOTSTRAP_BASE_URL
  if ($u) { return $u }
  foreach ($name in @("bootstrap-oss.json", "bootstrap-oss.example.json")) {
    $path = Join-Path $Root "config\$name"
    if (Test-Path $path) {
      $cfg = Get-Content $path -Raw | ConvertFrom-Json
      if ($cfg.baseUrl) { return [string]$cfg.baseUrl }
    }
  }
  return $null
}

function Invoke-WebRequestDirect {
  param([string]$Uri, [string]$OutFile, [hashtable]$Headers = @{})
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
  try {
    $request = New-Object System.Net.Http.HttpRequestMessage @([System.Net.Http.HttpMethod]::Get, $Uri)
    foreach ($key in @($Headers.Keys)) { [void]$request.Headers.TryAddWithoutValidation($key, [string]$Headers[$key]) }
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    try {
      if (-not $response.IsSuccessStatusCode) { throw ('HTTP ' + [int]$response.StatusCode + ' ' + $response.ReasonPhrase + ': GET ' + $Uri) }
      $parent = Split-Path -LiteralPath $OutFile -Parent
      if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      try {
        $fs = New-Object System.IO.FileStream($OutFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $stream.CopyTo($fs) } finally { $fs.Dispose() }
      }
      finally { $stream.Dispose() }
    }
    finally { $response.Dispose() }
  }
  finally { $client.Dispose() }
}

function Invoke-OssSignedObjectGet {
  param([string]$UriString, [string]$OutFile, [string]$AccessKeyId, [string]$AccessKeySecret)
  $uri = [Uri]$UriString
  $hostName = $uri.Host
  $m = [regex]::Match($hostName, '^(?<bucket>[^.]+)\.(?<suffix>oss-.+\.aliyuncs\.com)$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($m.Success) {
    $bucket = $m.Groups["bucket"].Value
    $objectKey = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart("/"))
  }
  else {
    $segments = @($uri.AbsolutePath.Trim("/").Split([char[]]'/', [StringSplitOptions]::RemoveEmptyEntries))
    if ($segments.Count -lt 2) { throw "Cannot derive bucket/object key from OSS URL: $UriString" }
    $bucket = $segments[0]
    $objectKey = [Uri]::UnescapeDataString(($segments[1..($segments.Count - 1)] -join "/"))
  }
  $canonicalResource = "/$bucket/$objectKey"
  $dateGmt = (Get-Date).ToUniversalTime().ToString("ddd, dd MMM yyyy HH:mm:ss \G\M\T", [Globalization.CultureInfo]::InvariantCulture)
  $stringToSign = "GET`n`n`n$dateGmt`n$canonicalResource"
  $hmac = New-Object System.Security.Cryptography.HMACSHA1
  try {
    $hmac.Key = [Text.Encoding]::UTF8.GetBytes($AccessKeySecret)
    $sig = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($stringToSign)))
  }
  finally { $hmac.Dispose() }
  Invoke-WebRequestDirect -Uri $UriString -OutFile $OutFile -Headers @{ "Date" = $dateGmt; "Authorization" = "OSS ${AccessKeyId}:$sig" }
}

function Ensure-LocalPython {
  if (Test-Path $PythonExe) { return }
  Write-Host "Local Python runtime: missing, downloading bootstrap runtime..."
  New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

  $vendorArchive = Join-Path $Root "resources\vendor_archives\$ArchiveName"
  if (Test-Path $vendorArchive) {
    $archive = $vendorArchive
  }
  else {
    $baseUrl = Get-BootstrapBaseUrl
    if (-not $baseUrl) { throw "Missing bootstrap OSS URL. Set GAMEDRAFT_BOOTSTRAP_BASE_URL or provide config/bootstrap-oss.json." }
    $cacheDir = Join-Path $Root ".cache\bootstrap"
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    $archive = Join-Path $cacheDir $ArchiveName
    $url = $baseUrl.TrimEnd("/") + "/" + $ArchiveName
    $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
    $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")
    if ($kid -and $ks) {
      Write-Host ("Downloading DVC portable runtime - OSS signed GET - from " + $url)
      Invoke-OssSignedObjectGet -UriString $url -OutFile $archive -AccessKeyId $kid -AccessKeySecret $ks
    }
    else {
      Write-Host ("Downloading DVC portable runtime - anonymous GET - from " + $url)
      Invoke-WebRequestDirect -Uri $url -OutFile $archive
    }
  }

  Write-Host "Extracting $ArchiveName"
  Expand-Archive -LiteralPath $archive -DestinationPath $ToolsDir -Force
  if (-not (Test-Path $PythonExe)) { throw "DVC portable runtime did not extract to .tools/Python311." }
}

Mask-ProxyEnv
Ensure-OssCredentials
Ensure-LocalPython

& $PythonExe -m tools.dev bootstrap $Action
exit $LASTEXITCODE
