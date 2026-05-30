@echo off
setlocal
pushd "%~dp0..\.."
".tools\Python311\python.exe" "tools\planner_gui\planner_gui.py"
popd
endlocal
