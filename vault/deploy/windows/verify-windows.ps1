# Verify a Windows Vault deployment and write a machine-readable snapshot.
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-windows.ps1 -VaultHome C:\vault
# Outputs <VaultHome>\verify-status.json (no secrets) and prints the same data as text.
param(
  [string]$VaultHome = 'C:\vault',
  [int]$Port = 3460,
  [int]$DbPort = 5433,
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$KumaNodeModules = ''
)
$ErrorActionPreference = 'Continue'
$out = [ordered]@{
  host = $env:COMPUTERNAME
  generatedAt = (Get-Date).ToString('o')
  tasks = @()
  service = $null
  firewall = $null
  ports = [ordered]@{}
  health = $null
  monitor = $null
  backup = $null
  files = [ordered]@{}
}

foreach ($name in @('Vault', 'VaultBackup')) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { $out.tasks += [pscustomobject]@{ name = $name; state = 'NOT-REGISTERED' }; continue }
  $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
  $triggers = @()
  foreach ($t in $task.Triggers) { $triggers += $t.CimClass.CimClassName }
  $out.tasks += [pscustomobject]@{
    name = $name
    state = [string]$task.State
    principal = $task.Principal.UserId
    logonType = $task.Principal.LogonType
    runLevel = $task.Principal.RunLevel
    triggers = $triggers
    restartCount = $task.Settings.RestartCount
    restartInterval = [string]$task.Settings.RestartInterval
    executionTimeLimit = [string]$task.Settings.ExecutionTimeLimit
    lastRunTime = if ($info) { [string]$info.LastRunTime } else { $null }
    lastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
    nextRunTime = if ($info) { [string]$info.NextRunTime } else { $null }
  }
}

$svc = Get-CimInstance Win32_Service -Filter "Name='VaultPG'" -ErrorAction SilentlyContinue
if ($svc) {
  $out.service = [pscustomobject]@{ name = 'VaultPG'; state = $svc.State; startMode = $svc.StartMode; startName = $svc.StartName; path = $svc.PathName }
}

$fw = Get-NetFirewallRule -DisplayName ('Vault API (TCP ' + $Port + ')') -ErrorAction SilentlyContinue
if ($fw) {
  $pf = $fw | Get-NetFirewallPortFilter
  $out.firewall = [pscustomobject]@{ displayName = $fw.DisplayName; enabled = [string]$fw.Enabled; action = [string]$fw.Action; direction = [string]$fw.Direction; protocol = [string]$pf.Protocol; localPort = [string]$pf.LocalPort; profile = [string]$fw.Profile }
}

foreach ($p in @($Port, $DbPort)) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $out.ports[('tcp' + $p)] = [bool]$conn
}

try {
  $h = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/v1/health') -TimeoutSec 10
  $out.health = [pscustomobject]@{
    httpStatus = 200
    status = $h.status
    service = $h.service
    version = $h.version
    apiVersion = $h.apiVersion
    storageDriver = $h.storage.driver
    serverVersion = $h.storage.serverVersion
    migrationsApplied = $h.migrations.applied
    migrationsPending = $h.migrations.pending
    projectsTotal = $h.projects.total
    uptimeSeconds = $h.uptimeSeconds
  }
} catch {
  $out.health = [pscustomobject]@{ httpStatus = 0; error = $_.Exception.Message }
}

$verifyScript = Join-Path $VaultHome 'monitor\monitor-verify-vault.js'
if (Test-Path -LiteralPath $verifyScript) {
  if ($KumaNodeModules -ne '') { $env:NODE_PATH = $KumaNodeModules }
  $monOut = & $NodeExe $verifyScript 2>&1
  $monCode = $LASTEXITCODE
  if ($KumaNodeModules -ne '') { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue }
  $line = ($monOut | Where-Object { ("$_").StartsWith('KUMA_VAULT ') } | Select-Object -Last 1)
  if ($line) {
    $jsonText = $line.Substring('KUMA_VAULT '.Length)
    try {
      $parsed = $jsonText | ConvertFrom-Json
      $out.monitor = [pscustomobject]@{ verifyExit = $monCode; ok = $parsed.ok; monitorId = $parsed.monitorId; name = $parsed.name; url = $parsed.url; active = $parsed.active; lastStatus = $parsed.lastStatus; statusText = $parsed.statusText; time = $parsed.time }
    } catch { $out.monitor = [pscustomobject]@{ verifyExit = $monCode; error = 'parse_error'; raw = $jsonText } }
  } else {
    $out.monitor = [pscustomobject]@{ verifyExit = $monCode; error = 'no KUMA_VAULT line'; raw = (($monOut | Out-String).Trim()) }
  }
} else {
  $out.monitor = [pscustomobject]@{ error = ('missing ' + $verifyScript) }
}

$statusFile = Join-Path $VaultHome 'log\backup-status.txt'
if (Test-Path -LiteralPath $statusFile) {
  $text = (Get-Content -LiteralPath $statusFile -Raw).Trim()
  $parts = $text -split '\s+'
  $out.backup = [pscustomobject]@{ statusLine = $text; state = $parts[0]; time = if ($parts.Count -gt 1) { $parts[1] } else { $null }; bytes = if ($parts.Count -gt 2) { $parts[2] } else { $null }; seconds = if ($parts.Count -gt 3) { $parts[3] } else { $null } }
} else {
  $out.backup = [pscustomobject]@{ statusLine = $null; state = 'NO_STATUS_YET' }
}

foreach ($f in @('deploy-status.json', 'vault.env', 'run.bat', 'backup.ps1', 'status.ps1', 'verify-windows.ps1')) {
  $path = Join-Path $VaultHome $f
  $out.files[$f] = [bool](Test-Path -LiteralPath $path)
}
$out.files['app\src\server.mjs'] = [bool](Test-Path -LiteralPath (Join-Path $VaultHome 'app\src\server.mjs'))
$out.files['db\bin\postgres.exe'] = [bool](Test-Path -LiteralPath (Join-Path $VaultHome 'db\bin\postgres.exe'))
$out.files['data\pg\PG_VERSION'] = [bool](Test-Path -LiteralPath (Join-Path $VaultHome 'data\pg\PG_VERSION'))
$out.files['monitor\monitor-add-vault.js'] = [bool](Test-Path -LiteralPath (Join-Path $VaultHome 'monitor\monitor-add-vault.js'))

$json = $out | ConvertTo-Json -Depth 8
Set-Content -Path (Join-Path $VaultHome 'verify-status.json') -Value $json -Encoding UTF8
Write-Output $json
