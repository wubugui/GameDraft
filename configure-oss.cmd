@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure-oss.ps1" %*
