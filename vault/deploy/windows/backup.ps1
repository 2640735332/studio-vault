# Vault daily backup: logical Vault snapshot + restic repository + retention (daily14/w8/m6).
# Optional Windows deployment example; runs as SYSTEM from task "VaultBackup".
# The raw PostgreSQL data dir is excluded on purpose (not consistent while running); the logical
# snapshot produced by vault-backup.mjs is the DB backup.
# Outputs: <VaultHome>\log\backup.log, <VaultHome>\log\backup-status.txt (OK|FAIL <iso> <bytes> <sec>)
# ASCII only: .ps1 files executed by Task Scheduler must not contain non-ASCII text.
param(
  [string]$VaultHome = 'C:\vault',
  [int]$KeepDaily = 14,
  [int]$KeepWeekly = 8,
  [int]$KeepMonthly = 6,
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$ResticExe = 'C:\Program Files\restic\restic.exe',
  [string]$ResticPasswordFile = '',
  [string]$ResticRepo = '',
  [string]$ResticCacheDir = ''
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
if ([string]::IsNullOrWhiteSpace($ResticPasswordFile)) { $ResticPasswordFile = Join-Path $VaultHome 'secrets\restic-password.txt' }
if ([string]::IsNullOrWhiteSpace($ResticRepo)) { $ResticRepo = Join-Path $VaultHome 'backup\restic-repo' }
if ([string]::IsNullOrWhiteSpace($ResticCacheDir)) { $ResticCacheDir = Join-Path $VaultHome 'cache\restic' }
$AppDir = Join-Path $VaultHome 'app'
$LogDir = Join-Path $VaultHome 'log'
$LogFile = Join-Path $LogDir 'backup.log'
$StatusFile = Join-Path $LogDir 'backup-status.txt'
$BackupOut = Join-Path $VaultHome 'data\backup'
$EnvFile = Join-Path $VaultHome 'vault.env'
$Sources = @($AppDir, $BackupOut, $EnvFile, (Join-Path $VaultHome 'run.bat'))
$ExcludedPaths = @((Join-Path $VaultHome 'data\pg'), $LogFile)
$Excludes = @()
foreach ($excludedPath in $ExcludedPaths) { $Excludes += ($excludedPath -replace '\\', '/') }
$Script:Failed = $false
$StartTime = Get-Date
function Write-Log {
  param([string]$Message)
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
  try { Add-Content -Path $LogFile -Value $line -Encoding ASCII -ErrorAction Stop } catch { }
  Write-Output $line
}
function Add-Failure {
  param([string]$Message)
  $Script:Failed = $true
  Write-Log ('ERROR ' + $Message)
}
function Import-VaultEnv {
  if (-not (Test-Path -LiteralPath $EnvFile)) { throw ('missing ' + $EnvFile) }
  foreach ($line in (Get-Content -LiteralPath $EnvFile)) {
    $trim = $line.Trim()
    if ($trim -eq '' -or $trim.StartsWith('#')) { continue }
    $idx = $trim.IndexOf('=')
    if ($idx -le 0) { continue }
    $key = $trim.Substring(0, $idx).Trim()
    $value = $trim.Substring($idx + 1).Trim()
    if ($key -ne '') { Set-Item -Path ('Env:' + $key) -Value $value }
  }
}
New-Item -ItemType Directory -Force -Path $LogDir, $BackupOut | Out-Null
if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 5MB)) {
  Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.1') -Force -ErrorAction SilentlyContinue
}
Write-Log '============================================================'
Write-Log ('vault backup start host=' + $env:COMPUTERNAME + ' user=' + [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$snapshotBytes = 0
try {
  Import-VaultEnv
  if (-not (Test-Path -LiteralPath $NodeExe)) { throw ('node missing: ' + $NodeExe) }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out = & $NodeExe (Join-Path $AppDir 'scripts\vault-backup.mjs') '--out' $BackupOut '--label' 'daily' '--json' 2>&1
  $code = $LASTEXITCODE
  $sw.Stop()
  foreach ($line in $out) { if (("$line").Trim() -ne '') { Write-Log ('  vault-backup: ' + ("$line").Trim()) } }
  if ($code -ne 0) { throw ('vault-backup exit code ' + $code) }
  $latestDir = Get-ChildItem -LiteralPath $BackupOut -Directory -Filter 'vault-daily-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latestDir) { throw 'vault-backup left no output directory' }
  $manifestPath = Join-Path $latestDir.FullName 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw ('missing manifest ' + $manifestPath) }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $snapshotBytes = [int64]$manifest.files.snapshot.bytes
  Write-Log ('logical snapshot OK bytes=' + $snapshotBytes + ' manifest=' + $manifestPath + ' elapsed=' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's')
} catch {
  Add-Failure ('logical snapshot: ' + $_)
}
$snapshotId = ''
if (-not (Test-Path -LiteralPath $ResticExe)) {
  Add-Failure ('restic.exe missing: ' + $ResticExe)
} elseif (-not (Test-Path -LiteralPath $ResticPasswordFile)) {
  Add-Failure ('restic password file missing: ' + $ResticPasswordFile)
} else {
  $env:RESTIC_REPOSITORY = $ResticRepo
  $env:RESTIC_PASSWORD_FILE = $ResticPasswordFile
  $env:RESTIC_CACHE_DIR = $ResticCacheDir
  $resticArgs = @('backup', '--tag', 'vault-backup')
  foreach ($ex in $Excludes) { $resticArgs += '--exclude'; $resticArgs += $ex }
  foreach ($s in $Sources) { if (Test-Path -LiteralPath $s) { $resticArgs += $s } }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $out = & $ResticExe @resticArgs 2>&1
    $code = $LASTEXITCODE
    $sw.Stop()
    foreach ($line in $out) {
      $text = "$line"
      if ($text.Trim() -ne '') { Write-Log ('  restic: ' + $text.Trim()) }
      if ($text -match 'snapshot ([0-9a-f]{8,}) saved') { $snapshotId = $Matches[1] }
    }
    if ($code -ne 11) { break }
    Write-Log ('restic backup locked (attempt ' + $attempt + '), retrying in 20s')
    Start-Sleep -Seconds 20
  }
  if ($code -ne 0) { Add-Failure ('restic backup exit code ' + $code) }
  elseif ($snapshotId -eq '') { Add-Failure 'could not parse restic snapshot id' }
  else { Write-Log ('restic snapshot OK id=' + $snapshotId + ' elapsed=' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's') }
  if ($snapshotId -ne '') {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $forgetOut = & $ResticExe forget --keep-daily $KeepDaily --keep-weekly $KeepWeekly --keep-monthly $KeepMonthly --prune 2>&1
      $forgetCode = $LASTEXITCODE
      $sw.Stop()
      foreach ($line in $forgetOut) { if (("$line").Trim() -ne '') { Write-Log ('  restic: ' + ("$line").Trim()) } }
      if ($forgetCode -ne 11) { break }
      Write-Log ('restic forget locked (attempt ' + $attempt + '), retrying in 20s')
      Start-Sleep -Seconds 20
    }
    if ($forgetCode -ne 0) { Add-Failure ('restic forget exit code ' + $forgetCode) }
    else { Write-Log ('restic forget/prune OK elapsed=' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's') }
  }
}
$duration = [int64][math]::Round(((Get-Date) - $StartTime).TotalSeconds)
$totalBytes = $snapshotBytes
if ($snapshotId -ne '') {
  try {
    $statsRaw = & $ResticExe stats $snapshotId --json 2>$null
    $stats = ($statsRaw -join '') | ConvertFrom-Json
    if ($stats.total_size) { $totalBytes = [int64]$stats.total_size }
  } catch { }
}
if ($Script:Failed) { $state = 'FAIL' } else { $state = 'OK' }
$iso = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
$statusLine = $state + ' ' + $iso + ' ' + $totalBytes + ' ' + $duration
Set-Content -Path $StatusFile -Value $statusLine -Encoding ASCII
Write-Log ('vault backup end status=' + $statusLine)
if ($Script:Failed) { exit 1 } else { exit 0 }
