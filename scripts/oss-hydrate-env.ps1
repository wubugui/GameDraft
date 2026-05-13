# Shared helpers: copy OSS RAM keys from Windows User scope into Process so child
# processes (Python, DVC) reliably inherit them in the same PowerShell session.

function Sync-OssEnvUserToProcess {
  $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
  if (-not $kid) {
    $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "User")
    if ($kid) {
      [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_ID", $kid, "Process")
    }
  }
  $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")
  if (-not $ks) {
    $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "User")
    if ($ks) {
      [Environment]::SetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", $ks, "Process")
    }
  }
}

function Assert-OssCredentialsInProcess {
  Sync-OssEnvUserToProcess
  $kid = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_ID", "Process")
  $ks = [Environment]::GetEnvironmentVariable("OSS_ACCESS_KEY_SECRET", "Process")
  if (-not $kid -or -not $ks) {
    throw 'OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET must both be set in user or process environment. Run scripts\bootstrap.ps1 options 1 or 2 first, or export them in this shell before using OSS-backed scripts.'
  }
}
