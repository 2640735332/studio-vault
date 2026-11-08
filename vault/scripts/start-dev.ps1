# Start Vault in local dev mode (memory store, non-durable) on Windows.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dev.ps1 [-Port 3460]
param([int]$Port = 3460)
$ErrorActionPreference = 'Stop'
$env:VAULT_DB = 'memory'
$env:VAULT_BIND = '127.0.0.1'
$env:VAULT_PORT = [string]$Port
Write-Host ("[vault] dev mode: http://127.0.0.1:" + $Port + "/api/v1/health (memory store, non-durable)")
Write-Host "[vault] seeded demo projects: demo-project, demo-b"
Write-Host "[vault] dev tokens: vt_devtokena_dev-secret-a (admin demo-project) | vt_devtokenb_dev-secret-b (writer demo-b) | vt_devtokenm_dev-secret-m (admin both)"
Write-Host "[vault] memory mode cannot create durable tokens; stop with Ctrl+C"
$server = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\server.mjs'
& node $server
exit $LASTEXITCODE