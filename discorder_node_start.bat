@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or node is not on PATH.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%A in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%A"
if "%NODE_MAJOR%"=="22" (
  echo WARNING: Node 22 is known to be unstable for Discord VC receive.
  echo If STT shows bytes=0, install and use Node 20 LTS.
)

if not exist "node_modules" (
  echo Installing Node.js dependencies...
  npm.cmd install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File ".\start_ngrok.ps1"
npm.cmd start
pause
