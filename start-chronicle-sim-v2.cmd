@echo off
cd /d "%~dp0"
start "" python -m tools.chronicle_sim_v2
if errorlevel 1 pause
