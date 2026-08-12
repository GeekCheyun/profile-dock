// Sandboxie-Plus 内置集成模块
//
// 功能：
// 1. 自动下载 Sandboxie-Plus 便携版安装包
// 2. 提取到项目 sandboxie/ 目录
// 3. 注册内核驱动（SbieDrv.sys）和系统服务（SbieSvc.exe）
// 4. 启动服务
//
// 技术说明：
// - Sandboxie 的进程隔离依赖内核驱动，必须注册到系统（无法纯绿色运行）
// - 驱动注册需要管理员权限（通过 VBS runas 已获取）
// - 使用 KmdUtil.exe（Sandboxie 自带）注册驱动和服务
// - 首次安装后驱动常驻系统，应用退出不卸载（避免反复安装）

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { run, q, ROOT } from './util.js'
import { isBundledAvailable, getBundledDir } from './sandboxie.js'

const BUNDLED_DIR = getBundledDir()

// Sandboxie-Plus 最新版下载 URL（GitHub Releases）
// 使用 sandboxie-plus.com 官方下载页面提供的直链
const DOWNLOAD_URLS = [
  'https://github.com/sandboxie-plus/Sandboxie/releases/download/v1.17.6/Sandboxie-Plus-x64-v1.17.6.exe',
  'https://sandboxie-plus.com/downloads/Sandboxie-Plus-x64-v1.17.6.exe',
]

export interface SetupStatus {
  bundled: boolean // 内置文件是否存在
  driverInstalled: boolean // 驱动是否已注册
  serviceRunning: boolean // 服务是否在运行
  ready: boolean // 是否完全就绪
}

export interface SetupProgress {
  step: string
  progress: number // 0-100
  error?: string
}

/** 检查当前集成状态 */
export async function getSetupStatus(): Promise<SetupStatus> {
  const bundled = isBundledAvailable()

  // 检查驱动是否已注册
  const drvResult = await run('sc query SbieDrv', { timeout: 5000 })
  const driverInstalled = !/FAILED|not exist/i.test(drvResult.stderr) && /SERVICE_NAME/i.test(drvResult.stdout)

  // 检查服务是否在运行
  const svcResult = await run('sc query SbieSvc', { timeout: 5000 })
  const serviceRunning = /RUNNING/i.test(svcResult.stdout)

  return {
    bundled,
    driverInstalled,
    serviceRunning,
    // 就绪条件：驱动已注册 + 服务运行中（不要求必须内置，系统安装版也算就绪）
    ready: driverInstalled && serviceRunning,
  }
}

/**
 * 一键安装：下载 → 提取 → 注册驱动 → 启动服务
 * @param onProgress 进度回调
 */
export async function installBundled(
  onProgress?: (p: SetupProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  // 步骤 1：检查是否已就绪
  const status = await getSetupStatus()
  if (status.ready) {
    onProgress?.({ step: 'Sandboxie 已就绪', progress: 100 })
    return { ok: true }
  }

  // 步骤 2：下载便携版安装包
  if (!status.bundled) {
    onProgress?.({ step: '正在下载 Sandboxie-Plus 便携版（约 30MB）...', progress: 10 })
    const dlResult = await downloadAndExtract()
    if (!dlResult.ok) {
      return { ok: false, error: dlResult.error }
    }
    onProgress?.({ step: 'Sandboxie-Plus 文件已提取到项目目录', progress: 50 })
  }

  // 步骤 3：注册驱动和服务
  if (!status.driverInstalled || !status.serviceRunning) {
    onProgress?.({ step: '正在注册内核驱动和系统服务...', progress: 70 })
    const regResult = await registerDriverAndService()
    if (!regResult.ok) {
      return { ok: false, error: regResult.error }
    }
    onProgress?.({ step: '驱动和服务已注册', progress: 85 })
  }

  // 步骤 4：启动服务
  onProgress?.({ step: '正在启动 Sandboxie 服务...', progress: 90 })
  const startResult = await startService()
  if (!startResult.ok) {
    return { ok: false, error: startResult.error }
  }

  onProgress?.({ step: 'Sandboxie-Plus 集成完成', progress: 100 })
  return { ok: true }
}

/** 下载安装包并提取到 sandboxie/ 目录 */
async function downloadAndExtract(): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(BUNDLED_DIR)) {
    mkdirSync(BUNDLED_DIR, { recursive: true })
  }

  const installerPath = path.join(ROOT, 'sandboxie-installer.exe')

  // 尝试多个下载源
  let downloaded = false
  for (const url of DOWNLOAD_URLS) {
    onProgressLog(`尝试下载: ${url}`)
    // 使用 PowerShell 下载（比 Node https 更可靠地处理重定向和证书）
    const r = await run(
      `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${installerPath}' -UseBasicParsing -TimeoutSec 120"`,
      { timeout: 180000 }
    )
    if (r.ok && existsSync(installerPath)) {
      downloaded = true
      break
    }
  }

  if (!downloaded) {
    return { ok: false, error: '下载失败，请检查网络连接或手动下载 Sandboxie-Plus 到项目 sandboxie/ 目录' }
  }

  // 提取安装包到 sandboxie/ 目录（使用 /PORTABLE 参数静默提取）
  const extractResult = await run(
    `"${installerPath}" /PORTABLE=1 /SILENT /DIR="${BUNDLED_DIR}"`,
    { timeout: 120000 }
  )

  // 清理安装包
  try {
    if (existsSync(installerPath)) {
      await run(`del "${installerPath}"`, { timeout: 5000 })
    }
  } catch {}

  if (!isBundledAvailable()) {
    // 某些版本的安装程序不支持 /DIR 参数，尝试另一种提取方式
    // 安装到临时目录后复制
    const tempDir = path.join(ROOT, 'sandboxie-temp')
    const r2 = await run(`"${installerPath}" /PORTABLE=1 /SILENT /DIR="${tempDir}"`, { timeout: 120000 })
    if (r2.ok && existsSync(tempDir)) {
      // 复制文件
      await run(`xcopy "${tempDir}\\*" "${BUNDLED_DIR}\\" /E /I /Y /Q`, { timeout: 60000 })
      // 清理临时目录
      await run(`rmdir /s /q "${tempDir}"`, { timeout: 10000 })
    }
  }

  if (!isBundledAvailable()) {
    return { ok: false, error: '提取失败，请手动运行安装程序并选择便携模式提取到项目 sandboxie/ 目录' }
  }

  return { ok: true }
}

/** 注册内核驱动和系统服务 */
async function registerDriverAndService(): Promise<{ ok: boolean; error?: string }> {
  const kmdUtil = path.join(BUNDLED_DIR, 'KmdUtil.exe')
  if (!existsSync(kmdUtil)) {
    return { ok: false, error: `未找到 KmdUtil.exe（路径: ${kmdUtil}），无法注册驱动` }
  }

  const sbieDrvSys = path.join(BUNDLED_DIR, 'SbieDrv.sys')
  const sbieSvcExe = path.join(BUNDLED_DIR, 'SbieSvc.exe')
  const sbieMsgDll = path.join(BUNDLED_DIR, 'SbieMsg.dll')

  // 注册内核驱动 SbieDrv
  if (!existsSync(sbieDrvSys)) {
    return { ok: false, error: `未找到 SbieDrv.sys` }
  }
  const drvResult = await run(
    `${q(kmdUtil)} install SbieDrv ${q(sbieDrvSys)} type=kernel start=demand msgfile=${q(sbieMsgDll)} altitude=86900`,
    { timeout: 30000 }
  )
  // 如果已存在不算错误
  if (!drvResult.ok && !/already exists|已存在/i.test(drvResult.stderr)) {
    return { ok: false, error: `注册驱动失败: ${drvResult.stderr}` }
  }

  // 注册服务 SbieSvc
  if (!existsSync(sbieSvcExe)) {
    return { ok: false, error: `未找到 SbieSvc.exe` }
  }
  const svcResult = await run(
    `${q(kmdUtil)} install SbieSvc ${q(sbieSvcExe)} type=own start=auto display="Sandboxie Service" group=UIGroup msgfile=${q(sbieMsgDll)}`,
    { timeout: 30000 }
  )
  if (!svcResult.ok && !/already exists|已存在/i.test(svcResult.stderr)) {
    return { ok: false, error: `注册服务失败: ${svcResult.stderr}` }
  }

  return { ok: true }
}

/** 启动 SbieSvc 服务 */
async function startService(): Promise<{ ok: boolean; error?: string }> {
  const kmdUtil = path.join(BUNDLED_DIR, 'KmdUtil.exe')

  // 使用 KmdUtil 启动服务
  const r = await run(`${q(kmdUtil)} start SbieSvc`, { timeout: 30000 })
  if (!r.ok) {
    // 退回到 sc start
    const r2 = await run('sc start SbieSvc', { timeout: 15000 })
    if (!r2.ok) {
      return { ok: false, error: `启动服务失败: ${r.stderr || r2.stderr}` }
    }
  }

  // 等待服务真正启动
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // 验证服务状态
  const check = await run('sc query SbieSvc', { timeout: 5000 })
  if (!/RUNNING/i.test(check.stdout)) {
    return { ok: false, error: '服务启动后状态异常，可能需要重启系统' }
  }

  return { ok: true }
}

/** 卸载内置 Sandboxie 驱动和服务 */
export async function uninstallBundled(): Promise<{ ok: boolean; error?: string }> {
  const kmdUtil = path.join(BUNDLED_DIR, 'KmdUtil.exe')
  if (!existsSync(kmdUtil)) {
    return { ok: false, error: '未找到 KmdUtil.exe' }
  }

  // 停止服务
  await run(`${q(kmdUtil)} stop SbieSvc`, { timeout: 15000 }).catch(() => {})
  await run('sc stop SbieSvc', { timeout: 10000 }).catch(() => {})

  // 卸载驱动和服务
  await run(`${q(kmdUtil)} delete SbieSvc`, { timeout: 15000 }).catch(() => {})
  await run(`${q(kmdUtil)} delete SbieDrv`, { timeout: 15000 }).catch(() => {})
  await run('sc delete SbieSvc', { timeout: 10000 }).catch(() => {})
  await run('sc delete SbieDrv', { timeout: 10000 }).catch(() => {})

  return { ok: true }
}

// 简单的日志输出（便于调试）
let onProgressLog: (msg: string) => void = (msg) => console.log(`[SandboxieSetup] ${msg}`)
export function setProgressLogger(fn: (msg: string) => void) {
  onProgressLog = fn
}
