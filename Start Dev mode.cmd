@echo off
rem Starts Dev mode. Keep this window open while you use Dev mode; close it to stop.
title Dev mode - close to stop
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0devmode-server.ps1"
