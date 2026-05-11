@echo off
setlocal

net session >nul 2>nul
if errorlevel 1 (
  echo Run this file as Administrator.
  pause
  exit /b 1
)

for /f "delims=" %%A in ('where node') do (
  set "NODE_EXE=%%A"
  goto found_node
)

echo node.exe was not found on PATH.
pause
exit /b 1

:found_node
echo Allowing node.exe through Windows Defender Firewall:
echo %NODE_EXE%

netsh advfirewall firewall delete rule name="DisCoder Node Voice UDP" program="%NODE_EXE%" >nul 2>nul
netsh advfirewall firewall delete rule name="DisCoder Node Voice TCP" program="%NODE_EXE%" >nul 2>nul

netsh advfirewall firewall add rule name="DisCoder Node Voice UDP" dir=out action=allow program="%NODE_EXE%" protocol=UDP profile=any
netsh advfirewall firewall add rule name="DisCoder Node Voice UDP" dir=in action=allow program="%NODE_EXE%" protocol=UDP profile=any
netsh advfirewall firewall add rule name="DisCoder Node Voice TCP" dir=out action=allow program="%NODE_EXE%" protocol=TCP profile=any
netsh advfirewall firewall add rule name="DisCoder Node Voice TCP" dir=in action=allow program="%NODE_EXE%" protocol=TCP profile=any

echo Done.
pause
