@echo off
cd /d "%~dp0"
python -m tools.dialogue_graph_editor --project "%~dp0."
if errorlevel 1 pause
