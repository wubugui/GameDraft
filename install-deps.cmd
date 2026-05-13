@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-deps.ps1" %*
