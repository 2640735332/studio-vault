# Remove the Vault scheduled tasks. Data under <VaultHome>\data is preserved.
param(
  [string]$VaultHome = "C:\vault"
)
$ErrorActionPreference = "Continue"
Stop-ScheduledTask -TaskName "Vault" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Vault" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "VaultBackup" -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "scheduled tasks removed; data kept at $(Join-Path $VaultHome 'data')"
