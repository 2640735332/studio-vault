@echo off
rem Vault API launcher for a Windows deployment (optional example).
rem Layout: <VAULT_HOME>\{app,data,db,log,run.bat,vault.env}; scheduled task "Vault"
rem (AtStartup + SYSTEM + RestartOnFailure). ASCII only on purpose.
setlocal
if "%VAULT_HOME%"=="" set "VAULT_HOME=C:\vault"
if not exist "%VAULT_HOME%\log" mkdir "%VAULT_HOME%\log"
if not exist "%VAULT_HOME%\data" mkdir "%VAULT_HOME%\data"

rem Load KEY=VALUE pairs from vault.env (kept out of git; see vault.env.example).
if exist "%VAULT_HOME%\vault.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%VAULT_HOME%\vault.env") do (
    if not "%%A"=="" if not "%%B"=="" set "%%A=%%B"
  )
)

if "%VAULT_BIND%"=="" set "VAULT_BIND=0.0.0.0"
if "%VAULT_PORT%"=="" set "VAULT_PORT=3460"
if "%VAULT_DATA_DIR%"=="" set "VAULT_DATA_DIR=%VAULT_HOME%\data"
if "%VAULT_LOG_LEVEL%"=="" set "VAULT_LOG_LEVEL=info"
if "%VAULT_OBJECT_STORE%"=="" set "VAULT_OBJECT_STORE=fs"
if "%VAULT_PG_PORT%"=="" set "VAULT_PG_PORT=5433"
if "%NODE_EXE%"=="" set "NODE_EXE=C:\Program Files\nodejs\node.exe"

echo [%DATE% %TIME%] run.bat start>> "%VAULT_HOME%\log\vault-run.log"

rem Wait for the local PostgreSQL port before starting (DB service may still be booting).
powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i=0; $i -lt 120; $i++) { if (Test-NetConnection 127.0.0.1 -Port %VAULT_PG_PORT% -InformationLevel Quiet) { exit 0 }; Start-Sleep -Seconds 1 }; exit 1" 2>> "%VAULT_HOME%\log\vault-run.log"
if errorlevel 1 (
  echo [%DATE% %TIME%] postgres port not ready, exiting for task restart>> "%VAULT_HOME%\log\vault-run.log"
  exit /b 1
)

cd /d "%VAULT_HOME%\app"
echo [%DATE% %TIME%] starting node>> "%VAULT_HOME%\log\vault-run.log"
"%NODE_EXE%" src\server.mjs >> "%VAULT_HOME%\log\vault.log" 2>&1
echo [%DATE% %TIME%] node exited code=%ERRORLEVEL%>> "%VAULT_HOME%\log\vault-run.log"
exit /b %ERRORLEVEL%
