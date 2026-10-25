@echo off
title ApOffSend Setup
echo.
echo   Installing ApOffSend - this takes a minute...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/apreezofficial/apoffsend/main/public/install.ps1 | iex"
if errorlevel 1 (
  echo.
  echo   Something went wrong. Check your internet connection and try again.
)
echo.
pause
