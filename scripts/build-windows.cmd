@echo off
REM Double-clickable wrapper for build-windows.ps1.
REM
REM PowerShell refuses to run an unsigned .ps1 under the default execution
REM policy, which is the whole reason a working script appears to do nothing
REM when you double-click it. -ExecutionPolicy Bypass applies to this one
REM invocation only and changes no machine setting.
REM
REM Arguments pass straight through: build-windows.cmd -Version 0.5.0 -Fast
REM Set GAMEBLADE_NOPAUSE=1 to skip the pause at the end (for CI or scripting).

setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
set EXITCODE=%ERRORLEVEL%

echo.

REM String comparison rather than "equ": an empty EXITCODE would make a numeric
REM comparison a syntax error, and a syntax error here is another way to lose
REM the message the user actually needed.
if "%EXITCODE%"=="0" goto :pause_and_exit

REM 9009 is cmd's own "command not found". Nothing else in this file can
REM produce it, so it means powershell.exe was not on PATH — a different
REM problem from the script failing, and worth naming rather than showing a
REM bare exit code for.
if "%EXITCODE%"=="9009" (
  echo powershell.exe was not found on PATH.
  echo Windows PowerShell lives in %%SystemRoot%%\System32\WindowsPowerShell\v1.0\
) else (
  echo The build failed with exit code %EXITCODE%.
  echo The whole run was transcribed to build-windows.log at the repo root.
)

:pause_and_exit
REM Always pause, unless explicitly told not to.
REM
REM This used to try to detect whether it had been double-clicked, by testing
REM whether %CMDCMDLINE% began with "cmd /c". It does not: Explorer launches a
REM .cmd through the *full path* to the interpreter, so CMDCMDLINE begins with
REM "C:\WINDOWS\system32\cmd.exe /c ..." and that test never matched. The window
REM closed instantly on every double-click, taking the error with it — which
REM looked exactly like the script doing nothing at all.
REM
REM An unconditional pause cannot fail that way. From a console it costs one
REM keypress; the env var is there for anything automated.
if /i "%GAMEBLADE_NOPAUSE%"=="1" goto :finish
pause

:finish
exit /b %EXITCODE%
