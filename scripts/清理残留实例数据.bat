@echo off
setlocal

REM WorkBuddy multi-open tool - cleanup stale *.deleting-* instance dirs.
REM Double-click to run; works with normal (non-elevated) privileges because the
REM script removes the deny-delete ACE first. Right-click "Run as administrator"
REM also works as a fallback.

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cleanup-stale-instances.ps1"
echo.
pause
