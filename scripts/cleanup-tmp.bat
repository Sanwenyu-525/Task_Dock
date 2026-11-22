@echo off
setlocal EnableExtensions
rem Task Dock cleanup launcher.
rem The logic lives in cleanup-tmp.ps1 (UTF-8 with BOM) so Chinese UI
rem text never depends on the console code page.
rem Usage: cleanup-tmp.bat [hours] [/y]
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%cleanup-tmp.ps1" %*
set "RC=%errorlevel%"
endlocal & exit /b %RC%
