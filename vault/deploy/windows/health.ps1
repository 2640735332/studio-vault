# Probe the Vault health endpoint (used by deploy/status checks and the scheduled task guard).
param(
  [string]$Url = "http://127.0.0.1:3460/api/v1/health",
  [int]$TimeoutSec = 10
)
$ErrorActionPreference = "Stop"
try {
  $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
  $body = $response.Content | ConvertFrom-Json
  Write-Output ("status=" + $response.StatusCode + " health=" + $body.status + " version=" + $body.version + " driver=" + $body.storage.driver)
  if ($response.StatusCode -eq 200) { exit 0 } else { exit 1 }
} catch {
  Write-Output ("health probe failed: " + $_.Exception.Message)
  exit 1
}
