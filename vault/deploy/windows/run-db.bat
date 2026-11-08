@echo off
rem Manual foreground start of the bundled PostgreSQL for a Windows Vault deployment (optional example).
rem Production path is the Windows service "VaultPG" (registered by deploy-windows.ps1);
rem this script is for troubleshooting / first init only. ASCII only.
setlocal
if "%VAULT_HOME%"=="" set "VAULT_HOME=C:\vault"
if not exist "%VAULT_HOME%\log" mkdir "%VAULT_HOME%\log"
set "PGDATA=%VAULT_HOME%\data\pg"
set "PGPORT=5433"
if not exist "%PGDATA%\PG_VERSION" (
  echo [%DATE% %TIME%] PGDATA missing: %PGDATA%>> "%VAULT_HOME%\log\pg.log"
  exit /b 1
)
"%VAULT_HOME%\db\bin\postgres.exe" -D "%PGDATA%" -p %PGPORT% -h 127.0.0.1 >> "%VAULT_HOME%\log\pg-stdout.log" 2>&1
