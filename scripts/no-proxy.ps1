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

  try {
    & $ScriptBlock
  }
  finally {
    foreach ($Name in $Script:GameDraftProxyEnvNames) {
      [Environment]::SetEnvironmentVariable($Name, $Previous[$Name], "Process")
    }
  }
}
