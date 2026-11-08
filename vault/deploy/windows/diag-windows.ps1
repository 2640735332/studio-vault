# One-shot diagnostics for a Windows Vault deployment (optional example; read-only except a backup run).
# ASCII only.
param(
  [string]$VaultHome = 'C:\vault',
  [string]$ResticExe = '',
  [string]$ResticPasswordFile = '',
  [string]$ResticRepo = '',
  [string]$ResticCacheDir = '',
  [string]$KumaNodeModules = ''
)
$ErrorActionPreference = 'Continue'
Write-Output '== log dir =='
Get-ChildItem (Join-Path $VaultHome 'log') -File -ErrorAction SilentlyContinue | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String
Write-Output '== backup.log tail =='
$bl = Join-Path $VaultHome 'log\backup.log'
if (Test-Path $bl) { Get-Content $bl -Tail 20 | ForEach-Object { Write-Output ('blog: ' + $_) } } else { Write-Output 'no backup.log' }
Write-Output '== backup-status =='
$bs = Join-Path $VaultHome 'log\backup-status.txt'
if (Test-Path $bs) { Write-Output ('status: ' + (Get-Content $bs -Raw)) } else { Write-Output 'no backup-status.txt' }
Write-Output '== run backup via Start-Process =='
$child = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $VaultHome 'backup.ps1')) -Wait -PassThru -RedirectStandardOutput (Join-Path $VaultHome 'log\backup-run.out') -RedirectStandardError (Join-Path $VaultHome 'log\backup-run.err')
Write-Output ('backup_start_process_exit=' + $child.ExitCode)
Write-Output '== backup run stdout tail =='
Get-Content (Join-Path $VaultHome 'log\backup-run.out') -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('bout: ' + $_) }
Write-Output '== backup run stderr tail =='
Get-Content (Join-Path $VaultHome 'log\backup-run.err') -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ('berr: ' + $_) }
Write-Output '== backup status after run =='
if (Test-Path $bs) { Write-Output ('status: ' + (Get-Content $bs -Raw)) } else { Write-Output 'no backup-status.txt' }
Write-Output '== sqlite modules in monitor node_modules =='
if ($KumaNodeModules -ne '') {
  Get-ChildItem $KumaNodeModules -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'sqlite' } | Select-Object -ExpandProperty Name | Out-String
} else {
  Write-Output 'KumaNodeModules not provided; skipping'
}
Write-Output '== restic snapshots json =='
if ($ResticExe -ne '' -and $ResticPasswordFile -ne '' -and $ResticRepo -ne '') {
  $env:RESTIC_REPOSITORY = $ResticRepo
  $env:RESTIC_PASSWORD_FILE = $ResticPasswordFile
  if ($ResticCacheDir -ne '') { $env:RESTIC_CACHE_DIR = $ResticCacheDir }
  $snap = & $ResticExe snapshots --tag vault-backup --json 2>&1
  Write-Output ('restic_exit=' + $LASTEXITCODE)
  $snapText = ($snap | Out-String)
  Write-Output ('restic_json_len=' + $snapText.Length)
  try {
    $arr = $snapText | ConvertFrom-Json
    Write-Output ('vault_backup_snapshots=' + @($arr).Count)
    foreach ($s in @($arr)) { Write-Output ('snap ' + $s.short_id + ' time=' + $s.time + ' host=' + $s.hostname + ' paths=' + (@($s.paths) -join ';')) }
  } catch { Write-Output ('restic_parse_error=' + $_.Exception.Message) }
} else {
  Write-Output 'restic parameters not provided (ResticExe/ResticPasswordFile/ResticRepo); skipping'
}
