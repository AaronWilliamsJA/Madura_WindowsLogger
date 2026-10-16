@echo off
title Madura Logger
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)

node src\index.js --open
echo.
echo Madura Logger has stopped.
pause
