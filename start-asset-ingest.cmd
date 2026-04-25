@echo off
cd /d "%~dp0"
python -m tools.asset_ingest.main
if errorlevel 1 pause
