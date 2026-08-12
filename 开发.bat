@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo [Init] Installing dependencies...
  rem 国内加速：electron / electron-builder 二进制镜像
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  call npm install
)

echo Starting dev mode: Vite + Electron window
echo Note: real sandbox writes need admin - use the launcher bat
echo.
call npm run electron:dev
pause
