@echo off
REM 编译 hook DLL —— 使用 MSVC (Visual Studio Build Tools)
REM 产物：native\hook_dll\multiopen_hook.dll
REM
REM 依赖：
REM - Visual Studio Build Tools (含 Windows SDK)
REM - MinHook 源码（已内置在 native\minhook\）

setlocal enabledelayedexpansion

REM 查找 vcvarsall.bat
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"

if not exist "%VSWHERE%" (
    echo ERROR: vswhere.exe not found. Visual Studio Build Tools not installed?
    exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VSINSTALL=%%i"
)

if not defined VSINSTALL (
    echo ERROR: Visual Studio C++ tools not found.
    exit /b 1
)

call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat"

REM 切换到项目根目录
cd /d "%~dp0\.."

REM 编译输出目录
if not exist "native\build" mkdir "native\build"

REM 源文件列表
set "SRCS=native\hook_dll\hook_dll.c native\minhook\src\buffer.c native\minhook\src\hook.c native\minhook\src\trampoline.c native\minhook\src\hde\hde32.c native\minhook\src\hde\hde64.c"

REM 头文件路径
set "INCS=/I native\minhook\include /I native\hook_dll"

REM 编译选项
set "CFLAGS=/nologo /O2 /MT /W3 /D_CRT_SECURE_NO_WARNINGS /DWIN32 /D_WINDOWS /D_USRDLL /DMULTIOPEN_HOOK_EXPORTS"

REM 链接选项
set "LDFLAGS=/nologo /DLL /OUT:native\build\multiopen_hook.dll /SUBSYSTEM:WINDOWS /MACHINE:X64"

echo Compiling hook DLL...
cl %CFLAGS% %INCS% %SRCS% /link %LDFLAGS% /DEF:native\hook_dll\multiopen_hook.def

if %ERRORLEVEL% equ 0 (
    echo.
    echo SUCCESS: native\build\multiopen_hook.dll built
    dir "native\build\multiopen_hook.dll"
) else (
    echo.
    echo FAILED: build error
    exit /b 1
)

endlocal
