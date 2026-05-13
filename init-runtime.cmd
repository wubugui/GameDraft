@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\init-runtime.ps1" %*
