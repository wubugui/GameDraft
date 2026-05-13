$Script:GameDraftProxyEnvNames = @(
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
)

function Invoke-WithoutProxy {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$ScriptBlock
  )

  $Previous = @{}
  foreach ($Name in $Script:GameDraftProxyEnvNames) {
    $Previous[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
    [Environment]::SetEnvironmentVariable($Name, $null, "Process")
  }
  # requests/urllib on Windows may fall back to the system proxy registry when
  # proxy env vars are absent; keep Aliyun/OSS bootstrap traffic direct.
  $AliyunNoProxy = "gamedraft-assets.oss-cn-shanghai.aliyuncs.com,*.oss-cn-shanghai.aliyuncs.com,*.aliyuncs.com,.aliyuncs.com,*.aliyun.com,.aliyun.com"
  [Environment]::SetEnvironmentVariable("NO_PROXY", $AliyunNoProxy, "Process")
  [Environment]::SetEnvironmentVariable("no_proxy", $AliyunNoProxy, "Process")

  try {
    & $ScriptBlock
  }
  finally {
    foreach ($Name in $Script:GameDraftProxyEnvNames) {
      [Environment]::SetEnvironmentVariable($Name, $Previous[$Name], "Process")
    }
  }
}
