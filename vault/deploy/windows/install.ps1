# Install / refresh a Windows Vault deployment (idempotent, optional example).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Source <repo>\vault [-Start]
#
# Layout: <VaultHome>\{app,data,log,run.bat}
# Scheduled task: "Vault" AtStartup, run as SYSTEM, RestartOnFailure (RestartCount=999, 1 min).
# Backup task:   "VaultBackup" daily 03:30, SYSTEM, runs windows\backup.ps1.
# ASCII-only on purpose: .ps1 files executed by scheduled tasks must not contain non-ASCII text.
param(
  [string]$Source = "",
  [string]$VaultHome = "C:\vault",
  [switch]$Start,
  [int]$Port = 3460
)
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Source)) {
  throw "Source path is required: -Source <repo>\vault"
}
if (-not (Test-Path (Join-Path $Source "src\server.mjs"))) {
  throw "Source does not look like the vault package: $Source"
}

foreach ($sub in @("app", "data", "data\backup", "log")) {
  $dir = Join-Path $VaultHome $sub
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

# Sync application files (no node_modules: the service is dependency free).
$appDir = Join-Path $VaultHome "app"
foreach ($item in @("package.json", "src", "migrations", "scripts", "README.md")) {
  $from = Join-Path $Source $item
  if (Test-Path $from) {
    & robocopy $from (Join-Path $appDir $item) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  }
}
& robocopy $Source $appDir "*.md" /NFL /NDL /NJH /NJS /NP | Out-Null

# Seed run.bat / health.ps1 / vault.env.example if the deployment directory is fresh.
$runBat = Join-Path $VaultHome "run.bat"
if (-not (Test-Path $runBat)) { Copy-Item (Join-Path $PSScriptRoot "run.bat") $runBat -Force }
$healthPs1 = Join-Path $VaultHome "health.ps1"
if (-not (Test-Path $healthPs1)) { Copy-Item (Join-Path $PSScriptRoot "health.ps1") $healthPs1 -Force }
$envExample = Join-Path $VaultHome "vault.env.example"
if (-not (Test-Path $envExample)) { Copy-Item (Join-Path $PSScriptRoot "vault.env.example") $envExample -Force }
$vaultEnv = Join-Path $VaultHome "vault.env"
if (-not (Test-Path $vaultEnv)) {
  Copy-Item $envExample $vaultEnv
  Write-Output "created $vaultEnv from template - fill PostgreSQL credentials before starting"
}

# Scheduled task: AtStartup, SYSTEM, run.bat, restart on failure.
$action = New-ScheduledTaskAction -Execute (Join-Path $VaultHome "run.bat") -WorkingDirectory $VaultHome
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$settings.RestartCount = 999
$settings.RestartInterval = (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Vault data service (port $Port, health /api/v1/health)"
Register-ScheduledTask -TaskName "Vault" -InputObject $task -Force | Out-Null
Write-Output "scheduled task Vault registered (AtStartup, SYSTEM, RestartOnFailure)"

# Daily backup task 03:30.
$backupAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -ExecutionPolicy Bypass -File " + (Join-Path $PSScriptRoot "backup.ps1") + " -VaultHome " + $VaultHome)
$backupTrigger = New-ScheduledTaskTrigger -Daily -At 03:30
$backupPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "VaultBackup" -Action $backupAction -Trigger $backupTrigger -Principal $backupPrincipal -Settings $settings -Description "Vault daily backup (PG dump + logical snapshot)" -Force | Out-Null
Write-Output "scheduled task VaultBackup registered (daily 03:30, SYSTEM)"

if ($Start) {
  Start-ScheduledTask -TaskName "Vault"
  Write-Output "Vault task started"
}

Write-Output "health probe:"
& (Join-Path $PSScriptRoot "health.ps1") -Url ("http://127.0.0.1:" + $Port + "/api/v1/health")
