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

function Mask-GameDraftProxyEnvironmentProcess {
  foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $name = [string]$entry.Key
    if (-not (Test-GameDraftProxyRelatedEnvName $name)) {
      continue
    }
    # Empty Process-scoped value masks User/Machine proxy vars for child processes (pip/dvc/npm/git).
    [Environment]::SetEnvironmentVariable($name, '', 'Process')
  }

  # urllib/requests/git/curl honour NO_PROXY; * avoids hostname wildcard quirks for OSS endpoints.
  [Environment]::SetEnvironmentVariable('NO_PROXY', '*', 'Process')
  [Environment]::SetEnvironmentVariable('no_proxy', '*', 'Process')
}

function Initialize-BootstrapProcessWithoutProxy {
  Mask-GameDraftProxyEnvironmentProcess
}

function Invoke-OssWithoutProxy {
  <#
  Aliyun OSS phases only: temporarily mask proxy-related process env so DVC/sync-dvc-cache/oss2
  traffic does not use HTTP(S) proxy; restores env after the block.
  Keep git clone/push outside this wrapper so Git keeps the user's proxy settings.
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

  $previous = @{}
  foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    $name = [string]$entry.Key
    if (-not (Test-GameDraftProxyRelatedEnvName $name)) {
      continue
    }
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }

  Mask-GameDraftProxyEnvironmentProcess

  try {
    & $ScriptBlock
  }
  finally {
    foreach ($key in @($previous.Keys)) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
    }
  }
}

function Invoke-WebRequestDirect {
  <#
  GET with HttpClient UseProxy=false — ignores HTTP(S)_PROXY env and Windows IE/system proxy.
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
