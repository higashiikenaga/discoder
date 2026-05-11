@echo off
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" "bot.py"
) else (
  where py >nul 2>nul
  if not errorlevel 1 (
    py -3 "bot.py"
  ) else (
    python "bot.py"
  )
)
