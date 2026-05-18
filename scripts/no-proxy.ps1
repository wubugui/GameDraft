function Test-GameDraftProxyRelatedEnvName {
  param([Parameter(Mandatory = $true)][string]$Name)

  $lu = $Name.ToLowerInvariant()
  if ($lu.EndsWith('_proxy')) {
    return $true
  }
  if ($lu -eq 'no_proxy' -or $lu -eq 'all_proxy') {
    return $true
  }
  if ($lu.StartsWith('npm_config_') -and $lu.Contains('proxy')) {
    return $true
  }
  return $false
}

function Get-GameDraftProxyEnvironmentSnapshot {
  $snapshot = @{}
  foreach ($entry in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).GetEnumerator()) {
    $name = [string]$entry.Key
    if (-not (Test-GameDraftProxyRelatedEnvName $name)) {
      continue
    }
    $snapshot[$name] = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
  }
  return $snapshot
}

function Get-GameDraftGitProxyUrl {
  param([string]$ProxyUrl = '')
  $u = $ProxyUrl.Trim()
  if ([string]::IsNullOrWhiteSpace($u)) {
    $u = [Environment]::GetEnvironmentVariable('GAMEDRAFT_GIT_PROXY', 'Process')
  }
  if ([string]::IsNullOrWhiteSpace($u)) {
    $u = [Environment]::GetEnvironmentVariable('GAMEDRAFT_GIT_PROXY', 'User')
  }
  if ([string]::IsNullOrWhiteSpace($u)) {
    try {
      $u = [Environment]::GetEnvironmentVariable('GAMEDRAFT_GIT_PROXY', 'Machine')
    }
    catch {
    }
  }
  if ([string]::IsNullOrWhiteSpace($u)) {
    # Default local Git proxy (e.g. clash/v2ray mixed port); override with -GitProxy or GAMEDRAFT_GIT_PROXY.
    $u = 'http://127.0.0.1:7078'
  }
  return $u
}

function Invoke-GameDraftGitWithTemporaryProxy {
  param(
    [string]$ProxyUrl = '',
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$GitArgs
  )
  if ($null -eq $GitArgs -or $GitArgs.Count -eq 0) {
    throw ("Need at least one git argument.")
  }
  $u = Get-GameDraftGitProxyUrl -ProxyUrl $ProxyUrl
  $httpCfg = "http.proxy=$u"
  $httpsCfg = "https.proxy=$u"
  # Mask sets NO_PROXY=*; omit NO_PROXY for this git invocation so -c http.proxy applies.
  $prevNo = [Environment]::GetEnvironmentVariable("NO_PROXY", "Process")
  $prevNol = [Environment]::GetEnvironmentVariable("no_proxy", "Process")
  try {
    [Environment]::SetEnvironmentVariable("NO_PROXY", $null, "Process")
    [Environment]::SetEnvironmentVariable("no_proxy", $null, "Process")
    & git -c $httpCfg -c $httpsCfg @GitArgs
  }
  finally {
    [Environment]::SetEnvironmentVariable("NO_PROXY", $prevNo, "Process")
    [Environment]::SetEnvironmentVariable("no_proxy", $prevNol, "Process")
  }
}

function Set-GameDraftTemporaryGitProxy {
  param([string]$ProxyUrl = '')
  $u = Get-GameDraftGitProxyUrl -ProxyUrl $ProxyUrl
  [Environment]::SetEnvironmentVariable('HTTP_PROXY', $u, 'Process')
  [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $u, 'Process')
}

function Clear-GameDraftProxyEnvironmentProcess {
  $names = @()
  foreach ($entry in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).GetEnumerator()) {
    $name = [string]$entry.Key
    if (Test-GameDraftProxyRelatedEnvName $name) {
      $names += $name
    }
  }

  foreach ($name in $names) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
}

function Set-GameDraftProxyEnvironmentProcess {
  param([hashtable]$Snapshot = @{})

  Clear-GameDraftProxyEnvironmentProcess

  foreach ($key in @($Snapshot.Keys)) {
    [Environment]::SetEnvironmentVariable([string]$key, [string]$Snapshot[$key], 'Process')
  }
}

function Mask-GameDraftProxyEnvironmentProcess {
  Clear-GameDraftProxyEnvironmentProcess

  # urllib/requests/git/curl honour NO_PROXY; * avoids hostname wildcard quirks for OSS endpoints.
  [Environment]::SetEnvironmentVariable('NO_PROXY', '*', 'Process')
  [Environment]::SetEnvironmentVariable('no_proxy', '*', 'Process')
}

function Initialize-BootstrapProcessWithoutProxy {
  Mask-GameDraftProxyEnvironmentProcess
}

function Invoke-OssWithoutProxy {
  <#
  Aliyun OSS phases only: mask proxy-related process env for DVC/sync-dvc-cache/oss2.
  Orchestrator scripts (push-all / pull-all) should call Mask-GameDraftProxyEnvironmentProcess once at entry so the finally block of Invoke-WithoutProxy does not restore inherited HTTP(S)_PROXY mid-run.
  Git remotes: use Invoke-GameDraftGitWithTemporaryProxy (-GitProxy or GAMEDRAFT_GIT_PROXY) so only that git process sees http.proxy/https.proxy (-c), not the whole PowerShell process.
  #>
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$ScriptBlock
  )

  Invoke-WithoutProxy -ScriptBlock $ScriptBlock
}

function Invoke-WithoutProxy {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$ScriptBlock
  )

  $previous = Get-GameDraftProxyEnvironmentSnapshot
  Mask-GameDraftProxyEnvironmentProcess

  try {
    & $ScriptBlock
  }
  finally {
    Set-GameDraftProxyEnvironmentProcess -Snapshot $previous
  }
}

function Invoke-WebRequestDirect {
  <#
  GET with HttpClient UseProxy=false - ignores HTTP(S)_PROXY env and Windows IE/system proxy.
  Use for OSS bootstrap downloads; Invoke-WebRequest still respects default WebProxy by default.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [hashtable]$Headers = @{}
  )

  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
  try {
    $request = New-Object System.Net.Http.HttpRequestMessage @([System.Net.Http.HttpMethod]::Get, $Uri)
    foreach ($key in @($Headers.Keys)) {
      [void]$request.Headers.TryAddWithoutValidation($key, [string]$Headers[$key])
    }

    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    try {
      if (-not $response.IsSuccessStatusCode) {
        throw ('HTTP ' + [int]$response.StatusCode + ' ' + $response.ReasonPhrase + ': GET ' + $Uri + ' failed.')
      }

      $parent = Split-Path -LiteralPath $OutFile -Parent
      if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
      }

      $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      try {
        $fs = New-Object System.IO.FileStream (
          $OutFile,
          [System.IO.FileMode]::Create,
          [System.IO.FileAccess]::Write,
          [System.IO.FileShare]::None
        )
        try {
          $stream.CopyTo($fs)
        }
        finally {
          $fs.Dispose()
        }
      }
      finally {
        $stream.Dispose()
      }
    }
    finally {
      $response.Dispose()
    }
  }
  finally {
    $client.Dispose()
  }
}
