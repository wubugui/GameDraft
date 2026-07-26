@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

rem Match tools.dev.launch Windows tool env.
set "PYDANTIC_DISABLE_PLUGINS=1"

set "VENV_PY=%CD%\.tools\venv\Scripts\python.exe"
if exist "%VENV_PY%" (
  "%VENV_PY%" -m tools.dev console %*
  exit /b %ERRORLEVEL%
)

where python >nul 2>&1
if errorlevel 1 (
  echo [error] Python not found. Run bootstrap to create .tools\venv, or install Python on PATH.
  exit /b 1
)

python -m tools.dev console %*
exit /b %ERRORLEVEL%
