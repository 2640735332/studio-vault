# Restart resilience check for a Windows Vault deployment.
# Measures: (a) cold start of the Vault scheduled task after stopping the process,
# (b) Vault recovery after restarting the VaultPG PostgreSQL service.
# ASCII only (may run through PowerShell 5.1 from ssh).
param(
  [string]$VaultHome = 'C:\vault',
  [int]$Port = 3460,
  [int]$DbPort = 5433
)
$ErrorActionPreference = 'Continue'
function Wait-Health([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try {
      $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/api/v1/health') -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $r.Content }
    } catch { }
    Start-Sleep -Milliseconds 250
  }
  return $null
}
function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}
$result = [ordered]@{ host = $env:COMPUTERNAME; generatedAt = (Get-Date).ToString('o'); cases = @() }

# (a) stop Vault task + process, then start the task and time recovery
$caseA = [ordered]@{ name = 'task-cold-start'; ok = $false }
try {
  Stop-ScheduledTask -TaskName 'Vault' -ErrorAction SilentlyContinue
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'vault' }
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 120; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  $caseA.portClosed = -not [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Start-ScheduledTask -TaskName 'Vault'
  $health = Wait-Health $Port 180
  $sw.Stop()
  $caseA.readyMs = [int64]$sw.ElapsedMilliseconds
  $caseA.ok = [bool]$health
  if ($health) { $caseA.health = $health }
} catch { $caseA.error = $_.Exception.Message }
$result.cases += [pscustomobject]$caseA

# (b) restart the PostgreSQL service; Vault must recover without a restart
$caseB = [ordered]@{ name = 'db-service-restart'; ok = $false }
try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Restart-Service -Name 'VaultPG' -Force
  $portUp = Wait-Port $DbPort 120
  $caseB.dbPortUp = $portUp
  $caseB.dbReadyMs = [int64]$sw.ElapsedMilliseconds
  $health = Wait-Health $Port 120
  $sw.Stop()
  $caseB.recoveredMs = [int64]$sw.ElapsedMilliseconds
  $caseB.ok = [bool]$health
  if ($health) { $caseB.health = $health }
} catch { $caseB.error = $_.Exception.Message }
$result.cases += [pscustomobject]$caseB

$json = $result | ConvertTo-Json -Depth 8
Set-Content -Path (Join-Path $VaultHome 'restart-test.json') -Value $json -Encoding UTF8
Write-Output ('RESTART_TEST ' + ($json -replace '\r?\n', ' '))
