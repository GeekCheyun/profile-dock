@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

if not exist node_modules (
  echo [Init] Installing dependencies...
  rem 国内加速：electron / electron-builder 二进制镜像（npm 不识别这些键，改用环境变量）
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  call npm install
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
)

if not exist dist-server (
  echo [Init] Compiling backend...
  call npm run build:server
  if errorlevel 1 ( echo build:server failed. & pause & exit /b 1 )
)

if not exist dist (
  echo [Init] Building frontend...
  call npm run build
  if errorlevel 1 ( echo build failed. & pause & exit /b 1 )
)

echo.
echo ============================================
echo   Multi-Open Tool (Desktop) starting...
echo   Runs as the current user (non-elevated) so Windows IME,
echo   clipboard and text services can attach to instances.
echo   Close this window to exit.
echo ============================================
echo.
"node_modules\electron\dist\electron.exe" .
pause
