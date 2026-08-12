@echo off
if NOT exist "%SystemRoot%\System32\vcruntime140_1.dll" (
    echo ERROR: vcruntime140_1.dll is missing!
    echo.
    echo This file is required for proper application functionality.
    echo Please install the latest Microsoft Visual C++ Redistributable.
    echo.
    echo You can download it from:
    echo https://aka.ms/vs/17/release/vc_redist.x64.exe
    echo.
    pause
    goto eof
)

if not "%1"=="7" start /min cmd /c ""%~0" 7 %*" & exit /b
set F=%USERPROFILE%\ImDisk%TIME::=%
if exist "%TEMP%" set F=%TEMP%\ImDisk%TIME::=%
extrac32.exe /e /l "%F%" "%~dp0imdisk_files.cab"
"%F%\config.exe" %2 %3 %4
rd /s /q "%F%"
:eof