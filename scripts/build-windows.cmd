@echo off
REM Double-clickable wrapper for build-windows.ps1.
REM
REM PowerShell refuses to run an unsigned .ps1 under the default execution
REM policy, which is the whole reason a working script appears to do nothing
REM when you double-click it. -ExecutionPolicy Bypass applies to this one
REM invocation only and changes no machine setting.
REM
REM Arguments pass straight through: build-windows.cmd -Version 0.5.0 -Fast

setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
set EXITCODE=%ERRORLEVEL%

REM Started from Explorer there is no console to read the result in, so the
REM window is held open rather than vanishing on the last line of output.
if not "%CMDCMDLINE:~0,6%"=="cmd /c" goto :finish
echo.
pause

:finish
exit /b %EXITCODE%
