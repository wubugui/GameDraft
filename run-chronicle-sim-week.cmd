@echo off
REM 在仓库根目录调用周模拟 CLI（与 GUI 共用 tools.chronicle_sim_v2.core.sim.simulation_pipeline）
REM 用法: run-chronicle-sim-week.cmd <run_dir绝对或相对路径> --week 1
REM 或:   run-chronicle-sim-week.cmd <run_dir> --from 1 --to 3
cd /d "%~dp0"
set PYTHONPATH=%CD%
python tools\chronicle_sim_v2\scripts\run_simulation_once.py %*
if errorlevel 1 pause
