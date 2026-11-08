# Deploy Vault (API + bundled PostgreSQL) on Windows as services/tasks (optional example).
#
# Usage on the Windows host (elevated), from this repository:
#   powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\vault\deploy\windows\deploy-windows.ps1 -Source <repo> -DbSource <path-to-postgres-binaries>
#   (-Source may point at the repository root; this script resolves the vault backend under <repo>\vault)
#
# Inputs (staging bundle, created by the operator with scp):
#   <VaultHome>\bundle\app      vault service tree (src, migrations, scripts, package.json)
#   <VaultHome>\bundle\db       PostgreSQL binaries (bin/lib/share)
#   <VaultHome>\bundle\windows  run.bat / run-db.bat / health.ps1 / backup.ps1 / status.ps1 / deploy-windows.ps1
#   <VaultHome>\bundle\monitor  monitor-add-vault.js
#
# Produces:
#   <VaultHome>\{app,db,data,log,monitor,run.bat,vault.env}
#   Windows service  VaultPG  (NetworkService, auto, restart on failure, 127.0.0.1:5433)
#   Scheduled task   Vault        (AtStartup, SYSTEM, RestartOnFailure, port 3460)
#   Scheduled task   VaultBackup  (daily 04:30, SYSTEM, restic daily14/w8/m6)
#   Firewall rule    Vault API (TCP 3460)  (Domain/Private)
#   Uptime Kuma monitor "Vault (127.0.0.1:3460)"
#   <VaultHome>\deploy-status.json  (machine-readable deployment evidence)
#
# ASCII only: this file runs through PowerShell 5.1 as SYSTEM/admin.
param(
  [string]$VaultHome = 'C:\vault',
  [string]$Source = '',
  [string]$DbSource = '',
  [int]$Port = 3460,
  [int]$DbPort = 5433,
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$KumaNodeModules = '',
  [switch]$SkipMonitor
)
$ErrorActionPreference = 'Stop'

# Source layout detection:
#   * monorepo: backend at <repo>\vault; -Source <repo root> is
#     resolved to <repo>\vault, and -Source <repo>\vault also works.
#   * standalone vault repo: API at the repo root (src/, migrations/, scripts/) with deploy/windows + deploy/monitor.
#   * legacy deployment bundle: app/, windows/, monitor/, db/.
# PostgreSQL binaries are not part of git, so -DbSource points at the staged portable build
# (default: <Source>\db, else <VaultHome>\bundle\db).
if (-not [string]::IsNullOrWhiteSpace($Source) -and (Test-Path -LiteralPath (Join-Path $Source 'vault\src\server.mjs'))) {
  $Source = Join-Path $Source 'vault'
}
if ([string]::IsNullOrWhiteSpace($Source)) {
  $repoCandidate = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  if ($repoCandidate -and (Test-Path -LiteralPath (Join-Path $repoCandidate 'src\server.mjs'))) { $Source = $repoCandidate }
  else { $Source = Join-Path $VaultHome 'bundle' }
}
$AppSource = if (Test-Path -LiteralPath (Join-Path $Source 'src\server.mjs')) { $Source } else { Join-Path $Source 'app' }
$WinSource = if (Test-Path -LiteralPath (Join-Path $Source 'deploy\windows')) { Join-Path $Source 'deploy\windows' } else { Join-Path $Source 'windows' }
$MonSource = if (Test-Path -LiteralPath (Join-Path $Source 'deploy\monitor')) { Join-Path $Source 'deploy\monitor' } else { Join-Path $Source 'monitor' }
$DbBinSource = if ($DbSource -ne '') { $DbSource } elseif (Test-Path -LiteralPath (Join-Path $Source 'db\bin\postgres.exe')) { Join-Path $Source 'db' } elseif (Test-Path -LiteralPath (Join-Path $VaultHome 'bundle\db\bin\postgres.exe')) { Join-Path $VaultHome 'bundle\db' } else { '' }
$AppHome = Join-Path $VaultHome 'app'
$DbHome = Join-Path $VaultHome 'db'
$DataHome = Join-Path $VaultHome 'data'
$PgData = Join-Path $DataHome 'pg'
$LogDir = Join-Path $VaultHome 'log'
$EnvFile = Join-Path $VaultHome 'vault.env'
$StatusFile = Join-Path $VaultHome 'deploy-status.json'

$Status = [ordered]@{
  host = $env:COMPUTERNAME
  user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  startedAt = (Get-Date).ToString('o')
  ok = $true
  steps = @()
  warnings = @()
  paths = [ordered]@{ vaultHome = $VaultHome; app = $AppHome; db = $DbHome; data = $DataHome; pgData = $PgData; log = $LogDir; env = $EnvFile; bundle = $Source }
  ports = [ordered]@{ api = $Port; postgres = $DbPort }
}
function Save-Status {
  $Status.finishedAt = (Get-Date).ToString('o')
  $Status | ConvertTo-Json -Depth 8 | Set-Content -Path $StatusFile -Encoding UTF8
}
function Add-Step([string]$name, [string]$detail) {
  $Status.steps += [pscustomobject]@{ step = $name; ok = $true; detail = $detail }
  Write-Output ('OK ' + $name + ': ' + $detail)
}
function Add-Warn([string]$name, [string]$detail) {
  $Status.warnings += [pscustomobject]@{ step = $name; detail = $detail }
  Write-Output ('WARN ' + $name + ': ' + $detail)
}
function Fail([string]$name, [string]$message) {
  $Status.ok = $false
  $Status.steps += [pscustomobject]@{ step = $name; ok = $false; detail = $message }
  Save-Status
  throw ($name + ' failed: ' + $message)
}
function Invoke-Robocopy([string]$from, [string]$to, [string[]]$ExcludeDirs = @()) {
  if (-not (Test-Path -LiteralPath $from)) { return -1 }
  $rcArgs = @($from, $to, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2')
  foreach ($d in $ExcludeDirs) { $rcArgs += '/XD'; $rcArgs += $d }
  & robocopy.exe @rcArgs | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw ('robocopy failed from ' + $from + ' code ' + $code) }
  return $code
}
function Get-EnvMap([string]$path) {
  $map = @{}
  if (Test-Path -LiteralPath $path) {
    foreach ($line in (Get-Content -LiteralPath $path)) {
      $t = $line.Trim()
      if ($t -eq '' -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -le 0) { continue }
      $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
    }
  }
  return $map
}
function New-RandomPassword {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $sb = ''
  for ($i = 0; $i -lt 32; $i++) { $sb += $chars[(Get-Random -Maximum $chars.Length)] }
  return $sb
}
function Wait-TcpPort([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}
# Run a native exe and capture merged stdout/stderr without PowerShell 5.1 turning
# redirected native stderr into terminating errors (ErrorActionPreference=Stop + 2>&1).
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = & $exe @arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
  $lines = @()
  foreach ($item in $raw) { $lines += ("$item") }
  return [pscustomobject]@{ code = $code; text = (($lines) -join [Environment]::NewLine) }
}

function Wait-Health([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try {
      $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/api/v1/health') -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $r.Content }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $null
}

try {
  # 0) preconditions
  if (-not (Test-Path -LiteralPath $NodeExe)) { Fail 'preflight' ('node missing: ' + $NodeExe) }
  if (-not (Test-Path -LiteralPath (Join-Path $AppSource 'src\server.mjs'))) { Fail 'preflight' ('vault app missing under ' + $AppSource) }
  if ($DbBinSource -eq '') { Fail 'preflight' 'PostgreSQL binaries not found: stage them under <Source>\db or pass -DbSource' }
  if (-not (Test-Path -LiteralPath (Join-Path $DbBinSource 'bin\postgres.exe'))) { Fail 'preflight' ('postgres binaries missing under ' + $DbBinSource) }
  Add-Step 'preflight' ('node=' + $NodeExe + ' app=' + $AppSource + ' db=' + $DbBinSource + ' windows=' + $WinSource + ' monitor=' + $MonSource)

  # 1) directories + file sync
  foreach ($d in @($VaultHome, $AppHome, $DbHome, $DataHome, (Join-Path $DataHome 'backup'), $LogDir, (Join-Path $VaultHome 'monitor'))) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
  $appExcludes = @()
  if ($AppSource -eq $Source -and (Test-Path -LiteralPath (Join-Path $Source 'deploy'))) {
    # standalone repo: copy the service tree only (no deploy/docs/test into the app dir)
    $appExcludes = @((Join-Path $Source 'deploy'), (Join-Path $Source '.git'), (Join-Path $Source 'test'), (Join-Path $Source 'docs'))
  }
  $rcApp = Invoke-Robocopy $AppSource $AppHome $appExcludes
  $rcDb = Invoke-Robocopy $DbBinSource $DbHome
  $rcWin = -1
  if (Test-Path -LiteralPath $WinSource) {
    Get-ChildItem -LiteralPath $WinSource -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $VaultHome $_.Name) -Force }
    $rcWin = 0
  }
  $rcMon = Invoke-Robocopy $MonSource (Join-Path $VaultHome 'monitor')
  Add-Step 'sync' ('robocopy app=' + $rcApp + ' db=' + $rcDb + ' windows=' + $rcWin + ' monitor=' + $rcMon)

  # 2) vault.env (generated once; keeps the DB password out of git)
  $envMap = Get-EnvMap $EnvFile
  $dbPassword = $envMap['VAULT_PG_PASSWORD']
  if ([string]::IsNullOrWhiteSpace($dbPassword)) {
    $dbPassword = New-RandomPassword
    $lines = @(
      '# Vault runtime env - generated by deploy-windows.ps1. Do not commit (contains DB password).',
      'VAULT_BIND=0.0.0.0',
      ('VAULT_PORT=' + $Port),
      'VAULT_DB=pg',
      'VAULT_PG_HOST=127.0.0.1',
      ('VAULT_PG_PORT=' + $DbPort),
      'VAULT_PG_USER=vault',
      ('VAULT_PG_PASSWORD=' + $dbPassword),
      'VAULT_PG_DB=vault',
      ('VAULT_DATA_DIR=' + $DataHome),
      'VAULT_OBJECT_STORE=fs',
      'VAULT_LOG_LEVEL=info',
      'VAULT_MIGRATE_ON_START=1',
      'VAULT_DEV_SEED=0',
      ('NODE_EXE=' + $NodeExe)
    )
    Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
    Add-Step 'vault.env' 'generated (random DB password, ACL restricted next)'
  } else {
    Add-Step 'vault.env' 'existing file kept'
  }
  & icacls.exe $EnvFile /inheritance:r | Out-Null
  & icacls.exe $EnvFile /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null

  # 3) PostgreSQL cluster init (elevated initdb is allowed; the *server* must run as NetworkService)
  $freshInit = $false
  if (-not (Test-Path -LiteralPath (Join-Path $PgData 'PG_VERSION'))) {
    if (Test-Path -LiteralPath $PgData) { Remove-Item -Recurse -Force $PgData }
    New-Item -ItemType Directory -Force -Path $PgData | Out-Null
    $pwFile = Join-Path $LogDir '.pgpw.tmp'
    Set-Content -Path $pwFile -Value $dbPassword -Encoding ASCII -NoNewline
    $initRun = Invoke-Native (Join-Path $DbHome 'bin\initdb.exe') @('-D', $PgData, '-U', 'vault', '--auth=scram-sha-256', '--pwfile', $pwFile, '-E', 'UTF8', '--locale=C')
    Remove-Item -LiteralPath $pwFile -Force -ErrorAction SilentlyContinue
    if ($initRun.code -ne 0) { Fail 'initdb' $initRun.text }
    Add-Content -Path (Join-Path $PgData 'postgresql.conf') -Value @('', '# --- vault deployment ---', "listen_addresses = '127.0.0.1'", ('port = ' + $DbPort), 'logging_collector = on', ("log_directory = '" + ($LogDir -replace '\\', '/') + "'"), "log_filename = 'pg-%Y%m%d.log'", 'log_min_messages = warning', 'log_line_prefix = ''%m [%p] ''', 'password_encryption = scram-sha-256')
    $freshInit = $true
    Add-Step 'initdb' ('cluster created at ' + $PgData)
  } else {
    Add-Step 'initdb' 'existing cluster kept'
  }
  # ACLs: SYSTEM + Administrators full, NetworkService (S-1-5-20) modify data/log, read+execute binaries
  foreach ($p in @($VaultHome, $DbHome, $DataHome, $PgData, $LogDir)) {
    & icacls.exe $p /grant '*S-1-5-18:(OI)(CI)F' /T /Q | Out-Null
    & icacls.exe $p /grant '*S-1-5-32-544:(OI)(CI)F' /T /Q | Out-Null
  }
  & icacls.exe $DbHome /grant '*S-1-5-20:(OI)(CI)RX' /T /Q | Out-Null
  foreach ($p in @($DataHome, $PgData, $LogDir, (Join-Path $DataHome 'backup'))) {
    & icacls.exe $p /grant '*S-1-5-20:(OI)(CI)M' /T /Q | Out-Null
  }
  Add-Step 'acl' 'SYSTEM/Administrators full; NetworkService modify on data/log; RX on db binaries'

  # 4) PostgreSQL Windows service (NetworkService; postgres refuses elevated admin tokens)
  $pgCtl = Join-Path $DbHome 'bin\pg_ctl.exe'
  $svc = Get-Service -Name 'VaultPG' -ErrorAction SilentlyContinue
  if ($svc) {
    if ($svc.Status -ne 'Stopped') { Stop-Service -Name 'VaultPG' -Force -ErrorAction SilentlyContinue }
    & sc.exe delete VaultPG | Out-Null
    Start-Sleep -Seconds 2
  }
  $regRun = Invoke-Native $pgCtl @('register', '-N', 'VaultPG', '-D', $PgData, '-S', 'auto', '-o', ('-p ' + $DbPort), '-U', 'NT AUTHORITY\NetworkService')
  if ($regRun.code -ne 0) { Fail 'service-register' $regRun.text }
  & sc.exe config VaultPG start= auto | Out-Null
  & sc.exe failure VaultPG reset= 86400 actions= restart/60000/restart/120000/restart/300000 | Out-Null
  Start-Service -Name 'VaultPG'
  $dbReady = Wait-TcpPort $DbPort 120
  if (-not $dbReady) {
    $pgLog = Join-Path $LogDir ('pg-' + (Get-Date -Format 'yyyyMMdd') + '.log')
    $tail = ''
    if (Test-Path -LiteralPath $pgLog) { $tail = (Get-Content -LiteralPath $pgLog -Tail 20 | Out-String) }
    Fail 'service-start' ('port ' + $DbPort + ' not listening; log=' + $tail)
  }
  $svcInfo = Get-Service -Name 'VaultPG'
  Add-Step 'service' ('VaultPG ' + $svcInfo.Status + ' startType=' + $svcInfo.StartType + ' port=' + $DbPort)

  # 5) create database + apply migrations through the Vault CLI
  $loaded = Get-EnvMap $EnvFile
  foreach ($k in $loaded.Keys) { Set-Item -Path ('Env:' + $k) -Value $loaded[$k] }
  Push-Location $AppHome
  try {
    $migRun = Invoke-Native $NodeExe @((Join-Path $AppHome 'scripts\vault-migrate.mjs'), '--create-database')
    if ($migRun.code -ne 0) { Fail 'migrate' $migRun.text }
    Add-Step 'migrate' ('vault-migrate --create-database exit 0 (' + $migRun.text.Length + ' bytes output)')
  } finally {
    Pop-Location
  }

  # 6) scheduled tasks: Vault (service) + VaultBackup (daily 04:30)
  $serviceSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  $systemPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Unregister-ScheduledTask -TaskName 'Vault' -Confirm:$false -ErrorAction SilentlyContinue
  $vaultAction = New-ScheduledTaskAction -Execute (Join-Path $VaultHome 'run.bat') -WorkingDirectory $VaultHome
  $vaultTrigger = New-ScheduledTaskTrigger -AtStartup
  Register-ScheduledTask -TaskName 'Vault' -Action $vaultAction -Trigger $vaultTrigger -Principal $systemPrincipal -Settings $serviceSettings -Description 'Vault data service API (port 3460, health /api/v1/health)' -Force | Out-Null
  Unregister-ScheduledTask -TaskName 'VaultBackup' -Confirm:$false -ErrorAction SilentlyContinue
  $backupAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $VaultHome 'backup.ps1') + '"') -WorkingDirectory $VaultHome
  $backupTrigger = New-ScheduledTaskTrigger -Daily -At '04:30'
  Register-ScheduledTask -TaskName 'VaultBackup' -Action $backupAction -Trigger $backupTrigger -Principal $systemPrincipal -Settings $serviceSettings -Description 'Vault daily logical backup + restic (daily14/w8/m6)' -Force | Out-Null
  $vaultTask = Get-ScheduledTask -TaskName 'Vault'
  $backupTask = Get-ScheduledTask -TaskName 'VaultBackup'
  Add-Step 'tasks' ('Vault=' + $vaultTask.State + ' VaultBackup=' + $backupTask.State)

  # 7) firewall rule (let LAN clients reach the API)
  $ruleName = 'Vault API (TCP ' + $Port + ')'
  $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if (-not $rule) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Domain,Private | Out-Null
    Add-Step 'firewall' ('created inbound TCP ' + $Port)
  } else {
    Add-Step 'firewall' ('rule exists: ' + $ruleName)
  }

  # 8) start Vault and wait for health 200
  Start-ScheduledTask -TaskName 'Vault'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $healthRaw = Wait-Health $Port 180
  $sw.Stop()
  if (-not $healthRaw) {
    $vaultLog = Join-Path $LogDir 'vault.log'
    $logTail = ''
    if (Test-Path -LiteralPath $vaultLog) { $logTail = (Get-Content -LiteralPath $vaultLog -Tail 15 | Out-String) }
    $runLog = Join-Path $LogDir 'vault-run.log'
    $runTail = ''
    if (Test-Path -LiteralPath $runLog) { $runTail = (Get-Content -LiteralPath $runLog -Tail 10 | Out-String) }
    Fail 'health' ('/api/v1/health did not return 200 within 180s (port ' + $Port + '); vault.log=' + $logTail + '; run.log=' + $runTail)
  }
  $health = $healthRaw | ConvertFrom-Json
  $Status.health = [ordered]@{
    status = $health.status
    version = $health.version
    apiVersion = $health.apiVersion
    storageDriver = $health.storage.driver
    serverVersion = $health.storage.serverVersion
    migrationsApplied = $health.migrations.applied
    migrationsPending = $health.migrations.pending
    uptimeSeconds = $health.uptimeSeconds
    readyMs = [int64]$sw.ElapsedMilliseconds
  }
  Add-Step 'health' ('200 status=' + $health.status + ' version=' + $health.version + ' driver=' + $health.storage.driver + ' readyMs=' + $Status.health.readyMs)

  # 9) Uptime Kuma monitor (best effort; failure is a warning, not a deployment failure)
  if (-not $SkipMonitor) {
    $monitorScript = Join-Path $VaultHome 'monitor\monitor-add-vault.js'
    if (Test-Path -LiteralPath $monitorScript) {
      if ($KumaNodeModules -ne '') { $env:NODE_PATH = $KumaNodeModules }
      $monRun = Invoke-Native $NodeExe @($monitorScript)
      if ($KumaNodeModules -ne '') { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue }
      if ($monRun.code -eq 0) { Add-Step 'monitor' $monRun.text.Trim() }
      else { Add-Warn 'monitor' $monRun.text.Trim() }
    } else {
      Add-Warn 'monitor' ('missing script ' + $monitorScript)
    }
  }

  Add-Step 'done' ('elapsed=' + [math]::Round(((Get-Date) - [datetime]::Parse($Status.startedAt)).TotalSeconds, 1) + 's vaultHome=' + $VaultHome)
} catch {
  $Status.ok = $false
  if (-not ($Status.steps | Where-Object { $_.ok -eq $false })) {
    $Status.steps += [pscustomobject]@{ step = 'unhandled'; ok = $false; detail = $_.Exception.Message }
  }
  Save-Status
  Write-Output ('DEPLOY FAILED: ' + $_.Exception.Message)
  exit 1
} finally {
  Save-Status
}
Write-Output ('DEPLOY_STATUS_PATH ' + $StatusFile)
Write-Output ($Status | ConvertTo-Json -Depth 6)
exit 0
