@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pull-all.ps1" %*
