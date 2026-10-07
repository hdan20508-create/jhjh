@echo off
rem Double-click to start the Clearance Checker. Keep this window open while you use it.
cd /d "%~dp0"
title Clearance Checker
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org, install it, then double-click this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
set OPEN_BROWSER=1
node src\server.js
pause
