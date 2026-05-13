@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\push-all.ps1" %*
