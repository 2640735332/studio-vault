# Vault deployment status snapshot (tasks, ports, health, backup) for a Windows host.
param(
  [string]$VaultHome = 'C:\vault',
  [int]$Port = 3460,
  [int]$DbPort = 5433
)
$ErrorActionPreference = 'Continue'
Write-Output '== scheduled tasks =='
foreach ($name in @('Vault', 'VaultBackup')) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $name
    Write-Output ($name + ' state=' + $task.State + ' lastRun=' + $info.LastRunTime + ' lastResult=' + $info.LastTaskResult)
  } else { Write-Output ($name + ' state=NOT-REGISTERED') }
}
Write-Output '== postgres service =='
$svc = Get-Service -Name 'VaultPG' -ErrorAction SilentlyContinue
if ($svc) { Write-Output ('VaultPG status=' + $svc.Status + ' startType=' + $svc.StartType) } else { Write-Output 'VaultPG status=NOT-INSTALLED' }
Write-Output '== ports =='
foreach ($p in @($Port, $DbPort)) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  Write-Output ('port ' + $p + ' listening=' + [bool]$conn)
}
Write-Output '== health =='
try {
  $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/api/v1/health') -UseBasicParsing -TimeoutSec 10
  Write-Output ('status=' + $r.StatusCode)
  Write-Output $r.Content
} catch { Write-Output ('health failed: ' + $_.Exception.Message) }
Write-Output '== backup status =='
$bf = Join-Path $VaultHome 'log\backup-status.txt'
if (Test-Path -LiteralPath $bf) { Get-Content -LiteralPath $bf } else { Write-Output 'no backup status yet' }
Write-Output '== recent vault log =='
$lf = Join-Path $VaultHome 'log\vault.log'
if (Test-Path -LiteralPath $lf) { Get-Content -LiteralPath $lf -Tail 8 } else { Write-Output 'no vault log yet' }
