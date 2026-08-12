// 自研轻量进程隔离引擎
//
// 稳定路径以持久化 Profile、实例私有环境和显式 Browser Broker 为边界。
// native Hook、设备身份/硬件伪装、指纹注入和代理环境覆盖均只保留为显式
// 兼容实验，不得因为 Profile.fingerprint.enabled 而自动启用。

import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync, appendFileSync, chmodSync, statSync } from 'node:fs'
import path from 'node:path'
import { exec, execFileSync, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import https from 'node:https'
import type { Profile, InstanceFingerprint } from './types.js'
import { generateFingerprint, fingerprintToEnvVars } from './fingerprint.js'
import { ROOT, readJsonWithBackup, writeJsonAtomic } from './util.js'
import { launchWithDllInjection, injectDllByPid } from './injector.js'
import { CdpInjector, allocateDebugPort, releaseDebugPort } from './cdp-injector.js'
import { detectSandboxie, Sandboxie } from './sandboxie.js'
import { getPidsWithEnvValue, parseBrowserParentPids } from './process-env.js'
import { isBrowserHookEnabled, isLegacyFingerprintEnabled, isNativeHookEnabled } from './runtime-policy.js'
import { createInstanceManifest, transitionInstanceState, type InstanceManifest } from './instance-manifest.js'
import { instanceLayout, isWithinRoot, resolveInstanceRoot, resolveProfileRoot } from './instance-layout.js'
import { attachProcessToJob, terminateInstanceJob } from './job-object.js'
import { parseTrustedEgress, verifyTrustedEgress } from './egress-manager.js'

const execAsync = promisify(exec)

const ENGINE_DIR = path.join(ROOT, 'engine')
const INSTANCES_ROOT = path.join(ENGINE_DIR, 'instances')
const sandboxieDetection = detectSandboxie()
const sandboxie = sandboxieDetection.installed
  ? new Sandboxie(sandboxieDetection.startExe, sandboxieDetection.sbieIniExe)
  : null
// Sandboxie is an optional hardening layer. The supported default is the
// application's persistent-profile isolation, which keeps each WorkBuddy
// instance's config, user data and child browser profile separate. Set
// MULTIOPEN_USE_SANDBOXIE=1 to opt into OS-level Sandboxie isolation.
const useSandboxie = process.env.MULTIOPEN_USE_SANDBOXIE === '1'
const requireSandboxie = process.env.MULTIOPEN_REQUIRE_SANDBOXIE === '1'

// ---- 宿主保护（统一防线） ----
// 本工具只管理 engine/instances 下的实例目录。任何进程终止、孤儿清理、浏览器
// 进程匹配都必须限定在该目录内，绝不允许触碰本机正常安装的 WorkBuddy（宿主应用）
// 的进程、配置或数据。所有由外部传入或从记录载入的 configDir/workDir 在使用前
// 都必须经过 managedInstanceDir 校验；校验失败的动作一律拒绝执行。
function managedInstanceDir(dir: string | null | undefined): string | null {
  if (!dir) return null
  const resolved = path.resolve(dir)
  const root = path.resolve(INSTANCES_ROOT)
  return isWithinRoot(root, resolved) ? resolved : null
}

/** 校验 --user-data-dir=<configDir> 形式的 marker 属于实例管理范围 */
function managedConfigMarker(marker: string): boolean {
  const prefix = '--user-data-dir='
  if (!marker.startsWith(prefix)) return false
  const configDir = marker.slice(prefix.length).replace(/^"|"$/g, '')
  return managedInstanceDir(configDir) !== null
}

// ==================== 后台进程监视器 ====================
//
// 解决"关闭应用窗口后进程仍显示运行中"问题：
// 用户关闭应用窗口后，主进程退出，但 crashpad_handler/GPU/渲染等 helper 进程可能残留。
// 后台监视器每 3 秒检查一次主进程是否存活，主进程退出后自动清理所有孤儿进程。
//
// 注意：这不是 UI 自动刷新（仍需手动点"刷新状态"），只是后台资源清理。

interface WatcherEntry {
  mainPid: number       // 主进程 PID（带 --user-data-dir 且无 --type=）
  marker: string         // --user-data-dir=<configDir>，用于扫描关联进程
  timer: NodeJS.Timeout  // setInterval 句柄
  deadCount: number      // 连续检测到主进程已死的次数（防误判）
}

const watchers = new Map<string, WatcherEntry>()  // key: profileId:index

// CDP 注入器追踪：key = profileId:index，用于实例终止时断开 CDP 连接
interface CdpEntry {
  injector: CdpInjector
  debugPort: number
  marker: string
}
const cdpInjectors = new Map<string, CdpEntry>()

/** 按 marker 停止匹配的 CDP 注入器（terminateInstance 时调用） */
function stopCdpByMarker(marker: string): void {
  for (const [key, entry] of cdpInjectors) {
    if (entry.marker === marker) {
      entry.injector.disconnect()
      releaseDebugPort(entry.debugPort)
      cdpInjectors.delete(key)
      console.log(`[CDP] 已断开并释放端口 (key=${key}, port=${entry.debugPort})`)
    }
  }
}

/**
 * 返回某实例关联的全部浏览器 user-data-dir 标记。
 * - browser-profile-v2：原生钩子重定向外链用的独立浏览器配置；
 * - appdata\Local\Microsoft\Edge\User Data：WorkBuddy 通过系统默认浏览器
 *   （shell.openExternal → Edge 默认配置）打开外链时，因 LOCALAPPDATA 已隔离，
 *   Edge 会把配置写进实例 appdata 下的这个目录。
 * 终止/删除实例时必须同时清理这两类浏览器进程，否则 Edge 会锁住配置目录、
 * 保留登录态，重建同序号实例后新浏览器会加入旧 Edge 会话导致“残留登录信息”。
 */
function browserMarkersForConfigMarker(marker: string): string[] {
  const prefix = '--user-data-dir='
  if (!managedConfigMarker(marker)) return []
  const configDir = marker.slice(prefix.length).replace(/^"|"$/g, '')
  const workDir = path.dirname(configDir)
  return [
    `${prefix}${path.join(workDir, 'browser-profile-v2')}`,
    `${prefix}${path.join(workDir, 'appdata', 'Local', 'Microsoft', 'Edge', 'User Data')}`,
  ]
}

/**
 * 通过环境变量识别实例拥有的浏览器进程（含 WorkBuddy 自己启动的
 * Edge 默认配置浏览器：主进程命令行无 user-data-dir，但子进程环境携带
 * LOCALAPPDATA=<实例>\appdata\Local，并通过 EDGE_BROWSER_PID 反查主进程）。
 */
function getInstanceBrowserPids(workDir: string): number[] {
  if (managedInstanceDir(workDir) === null) return []
  const found = new Set<number>()
  const children = getPidsWithEnvValue('LOCALAPPDATA', `${workDir}\\appdata\\Local`)
  for (const pid of children) {
    found.add(pid)
    for (const parent of parseBrowserParentPids(pid)) found.add(parent)
  }
  return Array.from(found)
}

/** 启动后台监视器：主进程退出后自动清理孤儿进程
 *
 * 关键修复：不再追踪固定的 mainPid（可能过时），而是每次用 findMainPid 动态查找。
 * 这样即使主进程重启或 PID 变化，监视器都能正确判断。
 */
function startWatcher(profileId: string, index: number, mainPid: number, marker: string): void {
  const key = `${profileId}:${index}`
  stopWatcher(profileId, index)

  const entry: WatcherEntry = {
    mainPid,
    marker,
    timer: null as any,
    deadCount: 0,
  }
  entry.timer = setInterval(async () => {
    // 宿主保护：marker 不属于实例管理范围时立即停止监视器，绝不清理外部进程。
    if (!managedConfigMarker(entry.marker)) {
      console.error(`[Watcher] 监视器 marker 不属于实例管理范围，已停止 (key=${key}, marker=${entry.marker})`)
      stopWatcher(profileId, index)
      return
    }
    // 动态查找主进程（不依赖固定 PID）
    const currentMainPid = findMainPid(entry.marker)
    if (currentMainPid > 0 && isProcessAlive(currentMainPid)) {
      entry.mainPid = currentMainPid
      entry.deadCount = 0
      return
    }
    entry.deadCount++

    // 连续 2 次检测到主进程已死（约 6 秒），确认窗口已关闭
    if (entry.deadCount < 2) return

    console.log(`[Watcher] 主进程已退出，清理孤儿进程 (marker=${entry.marker})`)
    await cleanupOrphans(entry.marker)
    const browserMarkers = browserMarkersForConfigMarker(entry.marker)
    for (const browserMarker of browserMarkers) await cleanupOrphans(browserMarker)
    // 环境变量匹配的 WorkBuddy 自启 Edge 浏览器（命令行无标记）
    const workDir = path.dirname(entry.marker.slice('--user-data-dir='.length).replace(/^"|"$/g, ''))
    for (const p of getInstanceBrowserPids(workDir)) {
      if (isProcessAlive(p)) {
        try {
          await execAsync(`taskkill /T /F /PID ${p}`, { timeout: 5000 })
        } catch {}
      }
    }

    // 再扫一次确保全部清理
    const remaining = getBoxPids(entry.marker)
    let browserRemaining: number[] = []
    for (const browserMarker of browserMarkers) {
      browserRemaining = [...browserRemaining, ...getBoxPids(browserMarker)]
    }
    for (const p of new Set([...remaining, ...browserRemaining])) {
      if (isProcessAlive(p)) {
        try {
          await execAsync(`taskkill /T /F /PID ${p}`, { timeout: 5000 })
        } catch {}
      }
    }

    stopWatcher(profileId, index)
    console.log(`[Watcher] 清理完成，监视器已停止 (key=${key})`)

    // 断开 CDP 连接并释放调试端口
    const cdpKey = `${profileId}:${index}`
    const cdpEntry = cdpInjectors.get(cdpKey)
    if (cdpEntry) {
      cdpEntry.injector.disconnect()
      releaseDebugPort(cdpEntry.debugPort)
      cdpInjectors.delete(cdpKey)
      console.log(`[Watcher] CDP 连接已断开 (key=${cdpKey}, port=${cdpEntry.debugPort})`)
    }
  }, 3000)

  watchers.set(key, entry)
  console.log(`[Watcher] 已启动监视器: PID=${mainPid} marker=${marker} (key=${key})`)
}

/** 停止后台监视器 */
function stopWatcher(profileId: string, index: number): void {
  const key = `${profileId}:${index}`
  const entry = watchers.get(key)
  if (entry) {
    clearInterval(entry.timer)
    watchers.delete(key)
  }
}

/** 按 marker 停止匹配的监视器（terminateInstance 时调用，无 profileId/index 信息） */
function stopWatcherByMarker(marker: string): void {
  for (const [key, entry] of watchers) {
    if (entry.marker === marker) {
      clearInterval(entry.timer)
      watchers.delete(key)
      console.log(`[Watcher] 已停止监视器 (key=${key})`)
    }
  }
}

/** 实例运行时信息 */
export interface InstanceRuntime {
  index: number
  pid: number
  boxName: string
  workDir: string
  running: boolean
  /** 该 box 关联的所有运行进程 PID（通过 --user-data-dir 匹配，含 launcher 已死后的子进程） */
  pids: number[]
  fingerprint: InstanceFingerprint
  createdAt: number
}

/** 实例持久化记录 */
export interface InstanceRecord {
  index: number
  boxName: string
  workDir: string
  pid: number
  fingerprint: InstanceFingerprint
  createdAt: number
  lastLaunchedAt: number
}

// ==================== 进程组扫描 ====================
//
// 关键问题：Chromium / Electron / Trae / VSCode 在 Windows 上是"launcher 立即派生真主进程"模型：
//   chrome.exe (PID=100, launcher) → 立即 CreateProcessW 派生 chrome.exe (PID=200, 真主进程) → launcher 退出
// 因此 CreateProcessW(CreateProcessA) + CREATE_SUSPENDED 拿到的 PID 是 launcher 进程，
// launcher 退出后该 PID 立即失效，UI 用 isProcessRunning(pid) 检测会得到 false（错的）。
//
// 解决：以 `--user-data-dir=<configDir>` 作为每个 box 的唯一标识（已通过 buildArgs 自动注入），
// 扫描所有进程，命令行中包含 configDir 的就是该 box 的所有进程。
// 这样无论 launcher 是否还活着，都能正确判断 box 是否在运行。

/**
 * 扫描系统进程，找出命令行包含指定 marker（如 `--user-data-dir=D:\path\config`）的所有进程 PID
 *
 * 关键修复：去掉进程名过滤（之前只查 chrome.exe/msedge.exe 等特定进程名），
 * 因为用户可能多开任何应用，进程名不在列表中就找不到。
 * 现在搜索所有进程，只通过命令行 marker 匹配。
 */
export function getBoxPids(marker: string): number[] {
  if (!marker) return []
  try {
    const escaped = marker.replace(/'/g, "''")
    // 不加 -Filter（按进程名过滤），直接搜索所有进程的 CommandLine
    // The query command line contains the marker itself. Exclude the shell
    // processes used to run this query so a later DLL injection pass cannot
    // accidentally target our own diagnostic process.
    const ps = `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Replace([string][char]34,[string]::Empty).Contains('${escaped}') -and $_.Name -notin @('powershell.exe','pwsh.exe','cmd.exe','conhost.exe','wmic.exe') } | Select-Object -ExpandProperty ProcessId`
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "${ps}"`,
      { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return Array.from(
      new Set(
        out
          .split(/\r?\n/)
          .map((s) => Number(s.trim()))
          .filter((n) => n > 0)
      )
    )
  } catch (e: any) {
    return []
  }
}

export interface InstanceProcessSnapshot {
  mainPid: number
  pids: number[]
}

/**
 * Capture Win32_Process once and group it by instance marker in memory.
 * The old list route launched two PowerShell/CIM scans per instance, making a
 * two-instance refresh take around 15 seconds on a busy workstation.
 */
export function scanInstanceProcesses(markers: string[]): Map<string, InstanceProcessSnapshot> {
  const result = new Map<string, InstanceProcessSnapshot>()
  const validMarkers = Array.from(new Set(markers.filter(Boolean)))
  for (const marker of validMarkers) result.set(marker, { mainPid: 0, pids: [] })
  if (validMarkers.length === 0) return result

  const markerPayload = Buffer.from(validMarkers.join('\n'), 'utf8').toString('base64')
  const script = [
    '$raw=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MULTIOPEN_SCAN_MARKERS_B64))',
    '$markers=@($raw.Split([char]10))',
    "$items=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.Name -notin @('powershell.exe','pwsh.exe','cmd.exe','conhost.exe','wmic.exe') }",
    'for($i=0;$i -lt $markers.Count;$i++){',
    '  $marker=[string]$markers[$i]',
    '  foreach($item in $items){',
    '    $normalized=$item.CommandLine.Replace([string][char]34,[string]::Empty)',
    '    if($normalized.Contains($marker)){',
    "      $isMain=if($item.CommandLine -notmatch '--type='){1}else{0}",
    "      Write-Output ([string]::Concat($i,'|',$item.ProcessId,'|',$isMain))",
    '    }',
    '  }',
    '}',
  ].join(';')

  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, MULTIOPEN_SCAN_MARKERS_B64: markerPayload },
    }).trim()
    if (!output) return result

    for (const line of output.split(/\r?\n/)) {
      const [indexText, pidText, mainText] = line.trim().split('|')
      const index = Number(indexText)
      const pid = Number(pidText)
      if (!Number.isInteger(index) || index < 0 || index >= validMarkers.length || pid <= 0) continue
      const marker = validMarkers[index]
      const snapshot = result.get(marker) || { mainPid: 0, pids: [] }
      if (!snapshot.pids.includes(pid)) snapshot.pids.push(pid)
      if (mainText === '1' && !snapshot.mainPid) snapshot.mainPid = pid
      result.set(marker, snapshot)
    }
  } catch (error: any) {
    console.warn(`[Engine] process snapshot failed: ${error?.message || error}`)
    // Preserve the fail-closed status behavior if CIM is unavailable.
  }
  return result
}

/**
 * 查找 box 的主进程 PID（带 `--user-data-dir` 且**不**带 `--type=` 的进程）
 *
 * 主进程 = 带窗口的那个进程（没有 --type= 标志）
 * helper 进程（GPU/渲染/crashpad）都有 --type= 标志
 * 关窗后主进程退出，helper 残留 → 之前用 getBoxPids 误判为运行中
 * 现在只用 findMainPid 判断：主进程不在 = 实例未运行
 *
 * 关键修复：去掉进程名过滤，搜索所有进程。
 */
export function findMainPid(marker: string): number {
  if (!marker) return 0
  try {
    const escaped = marker.replace(/'/g, "''")
    // 查找命令行包含 marker 且不含 --type= 的进程（即主进程，非子进程）
    // 额外条件：进程必须仍然存活（有模块加载），排除已退出的 launcher 僵尸进程
    const ps = `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Replace([string][char]34,[string]::Empty).Contains('${escaped}') -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId, ParentProcessId | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p -and $p.Modules.Count -gt 0) { $_.ProcessId } }`
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "${ps}"`,
      { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const pids = out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0)
    return pids[0] || 0
  } catch {
    return 0
  }
}

/**
 * 查找 box 关联的孤儿助手进程（带 --user-data-dir **且**带 --type= 的进程）
 *
 * 用途：主进程已退出后，清理残留的 crashpad_handler / GPU / 渲染进程等，
 *       防止"关闭应用后仍占用资源"。
 */
export function findOrphanPids(marker: string): number[] {
  if (!marker) return []
  try {
    const escaped = marker.replace(/'/g, "''")
    const ps = `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Replace([string][char]34,[string]::Empty).Contains('${escaped}') -and $_.CommandLine -match '--type=' } | Select-Object -ExpandProperty ProcessId`
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "${ps}"`,
      { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return Array.from(
      new Set(
        out
          .split(/\r?\n/)
          .map((s) => Number(s.trim()))
          .filter((n) => n > 0)
      )
    )
  } catch {
    return []
  }
}

/** 主动清理孤儿助手进程（主进程已死但 helper 残留时调用） */
export async function cleanupOrphans(marker: string): Promise<number> {
  const orphans = findOrphanPids(marker)
  let killed = 0
  for (const p of orphans) {
    if (!isProcessAlive(p)) continue
    try {
      await execAsync(`taskkill /T /F /PID ${p}`, { timeout: 5000 })
      killed++
    } catch {}
  }
  return killed
}

// ==================== 目录结构管理 ====================

function profileDir(profileId: string): string {
  const dir = resolveProfileRoot(INSTANCES_ROOT, profileId)
  if (!dir) throw new Error(`拒绝使用不安全的 profileId: ${profileId}`)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function instanceDir(profileId: string, index: number): string {
  const dir = resolveInstanceRoot(INSTANCES_ROOT, profileId, index)
  if (!dir) throw new Error(`拒绝使用不安全的实例路径: ${profileId}/${index}`)
  return dir
}

function manifestFile(profileId: string, index: number): string {
  return path.join(instanceDir(profileId, index), 'manifest.json')
}

function persistManifest(manifest: InstanceManifest): void {
  writeJsonAtomic(manifestFile(manifest.profileId, manifest.index), manifest)
}

export function loadInstanceManifest(profileId: string, index: number): InstanceManifest | null {
  const file = manifestFile(profileId, index)
  if (!existsSync(file)) return null
  const loaded = readJsonWithBackup<InstanceManifest>(file)
  if (!loaded?.value || loaded.value.schemaVersion !== 1) return null
  return loaded.value
}

function advanceManifest(
  manifest: InstanceManifest,
  state: Parameters<typeof transitionInstanceState>[1],
  options: Parameters<typeof transitionInstanceState>[2] = {},
): InstanceManifest {
  const next = transitionInstanceState(manifest, state, options)
  persistManifest(next)
  return next
}

/** 初始化实例工作目录，创建 Junction 连接到共享真实文件夹 */
function prepareInstanceDir(profile: Profile, index: number): string {
  const dir = instanceDir(profile.id, index)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const layout = instanceLayout(dir)
  for (const privateDir of Object.values(layout)) {
    if (!existsSync(privateDir)) mkdirSync(privateDir, { recursive: true })
  }

  // 为每个共享路径创建 Junction（等价 Sandboxie 的 OpenFilePath）
  const sharedDir = layout.shared

  for (const openPath of profile.openPaths) {
    if (!existsSync(openPath)) continue
    const linkName = path.join(sharedDir, path.basename(openPath))
    if (!existsSync(linkName)) {
      try {
        execSync(`mklink /J "${linkName}" "${openPath}"`, { shell: 'cmd.exe', timeout: 5000 })
      } catch {
        // Junction 创建失败不阻断
      }
    }
  }

  return dir
}

// ==================== 应用层设备 ID 重写 ====================
//
// 问题：Trae / VSCode 等 Electron 应用在首次启动时生成设备唯一标识，
//   并持久化到 config/User/globalStorage/storage.json：
//   - telemetry.machineId   (64 位十六进制哈希)
//   - telemetry.sqmId        (Windows GUID 格式)
//   - telemetry.devDeviceId  (UUID 格式)
//
//   这些 ID 是应用层的设备指纹，与系统 MachineGuid 无关。
//   即使隔离了系统注册表，应用仍通过这些 ID 被服务器识别为同一设备
//   → "当前设备今日已签到"。
//
// 方案：在实例启动前，用基于 fingerprint 的确定性值覆盖这些字段。
//   - 同一实例每次启动用相同值（基于 machineGuid 派生，保持一致性）
//   - 不同实例用不同值（machineGuid 不同 → 派生值不同）
//   - "换指纹"后 machineGuid 变化 → 设备 ID 随之变化 → 平台视为新设备

import { createHash } from 'node:crypto'

/** 从 box 的 machineGuid 派生确定性设备 ID（每次调用同一 box 结果相同） */
function deriveDeviceIds(machineGuid: string): {
  machineId: string      // 64 位十六进制（VSCode telemetry.machineId 格式）
  sqmId: string          // {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}（Windows GUID 格式）
  devDeviceId: string    // xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx（UUID 格式）
} {
  // 用 SHA-256 对 machineGuid 做多轮派生，确保各字段相互独立
  const h1 = createHash('sha256').update(machineGuid + ':machineId').digest('hex')  // 64 hex
  const h2 = createHash('sha256').update(machineGuid + ':sqmId').digest('hex')      // 64 hex
  const h3 = createHash('sha256').update(machineGuid + ':devDeviceId').digest('hex')// 64 hex

  // sqmId: 取 h2 前 32 位十六进制，格式化为 {8-4-4-4-12}
  const g = h2.slice(0, 32).toUpperCase()
  const sqmId = `{${g.slice(0,8)}-${g.slice(8,12)}-${g.slice(12,16)}-${g.slice(16,20)}-${g.slice(20,32)}}`

  // devDeviceId: 取 h3 前 32 位十六进制，格式化为 8-4-4-4-12（小写）
  const u = h3.slice(0, 32).toLowerCase()
  const devDeviceId = `${u.slice(0,8)}-${u.slice(8,12)}-${u.slice(12,16)}-${u.slice(16,20)}-${u.slice(20,32)}`

  return { machineId: h1, sqmId, devDeviceId }
}

/**
 * 重写实例 storage.json 中的应用层设备 ID
 *
 * 覆盖字段：
 * - telemetry.machineId
 * - telemetry.sqmId
 * - telemetry.devDeviceId
 *
 * 安全性：仅在文件存在时修改，保留其他字段不变；JSON 解析失败则跳过（不破坏应用数据）。
 * 幂等性：多次调用结果一致（基于 machineGuid 派生）。
 */
function rewriteAppDeviceIds(workDir: string, fingerprint: InstanceFingerprint): boolean {
  if (!fingerprint.machineGuid) return false

  // storage.json 路径：config/User/globalStorage/storage.json（VSCode/Trae 标准）
  const storageFile = path.join(workDir, 'config', 'User', 'globalStorage', 'storage.json')
  let identityChanged = true
  if (existsSync(storageFile)) {
    try {
      const current = JSON.parse(readFileSync(storageFile, 'utf-8'))
      const expected = deriveDeviceIds(fingerprint.machineGuid)
      identityChanged = current['telemetry.machineId'] !== expected.machineId || current['telemetry.sqmId'] !== expected.sqmId || current['telemetry.devDeviceId'] !== expected.devDeviceId
    } catch { identityChanged = true }
  }
  if (!existsSync(storageFile)) {
    // 首次启动：文件不存在，应用会在启动后生成。我们创建一个预置设备 ID 的文件，
    // 应用启动时会读取并使用（VSCode 在 storage.json 存在时不会重新生成 telemetry.* ID）
    try {
      const ids = deriveDeviceIds(fingerprint.machineGuid)
      const dir = path.dirname(storageFile)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const initial = {
        'telemetry.machineId': ids.machineId,
        'telemetry.sqmId': ids.sqmId,
        'telemetry.devDeviceId': ids.devDeviceId,
      }
      writeFileSync(storageFile, JSON.stringify(initial, null, 4), 'utf-8')
      console.log(`[Engine] 预置应用设备 ID (box=${fingerprint.machineGuid.slice(0,8)}...)`)
    } catch (e: any) {
      console.log(`[Engine] 预置设备 ID 失败: ${e?.message || e}`)
    }
    // Do not return here: first launch must also prepare local_env.json and
    // remove stale device/network caches before the child process starts.
  }

  // 文件已存在：读取、修改、写回
  try {
    const raw = readFileSync(storageFile, 'utf-8')
    const data = JSON.parse(raw)
    const ids = deriveDeviceIds(fingerprint.machineGuid)

    let changed = false
    if (data['telemetry.machineId'] !== ids.machineId) {
      data['telemetry.machineId'] = ids.machineId
      changed = true
    }
    if (data['telemetry.sqmId'] !== ids.sqmId) {
      data['telemetry.sqmId'] = ids.sqmId
      changed = true
    }
    if (data['telemetry.devDeviceId'] !== ids.devDeviceId) {
      data['telemetry.devDeviceId'] = ids.devDeviceId
      changed = true
    }

    // 清除 iCubeAuthInfo 相关键：这些键包含服务器绑定的 DeviceID（如 icube-dc:<DeviceID>），
    // 如果不清除，应用会复用旧 DeviceID → 服务器识别为同一设备 → "设备已签到"。
    // 清除后应用会重新登录，用新的计算机名（hook 伪造）+ 新 MachineID 生成新 DeviceID。
    // 注意：此清除逻辑也由 clearStaleAuthInfo() 独立执行（即使未启用指纹隔离也会调用），
    // 这里保留是为了在启用指纹隔离时与设备 ID 重写一起原子执行。
    for (const key of Object.keys(data)) {
      if (key.startsWith('iCubeAuthInfo://') || key.startsWith('iCubeServerData://')) {
        delete data[key]
        changed = true
      }
    }

    // 【关键修正】保留 has_device_id_updated_to_aha=true，不再删除它。
    // 之前删除此标记的本意是"强制应用重新注册设备"，但实测发现：
    // 删除后应用触发"重新注册"流程，从 env_codekg.db / 宿主路径读取旧 device_id，
    // 覆盖我们在 local_env.json 中预写的新值，导致 device_id 回退到旧值。
    // 保留此标记=true，应用会跳过重新注册，直接使用 local_env.json 中的 device_id（新值）。
    // 配合清除 iCubeAuthInfo（强制重新登录），应用会用新 device_id 向服务器注册。

    if (changed) {
      writeFileSync(storageFile, JSON.stringify(data, null, 4), 'utf-8')
      console.log(`[Engine] 已重写应用设备 ID 并清除旧认证信息 (box=${fingerprint.machineGuid.slice(0,8)}...)`)
    }
  } catch (e: any) {
    // JSON 解析失败或写入失败：不阻断启动，记录日志
    console.log(`[Engine] 重写设备 ID 失败（文件可能被占用或格式异常）: ${e?.message || e}`)
  }

  // ---- 重写 local_env.json 中的 device_id ----
  // local_env.json 位于 config/ModularData/ckg_server/local_env.json
  // Trae 的 ICubeDeviceRegisterService 从此文件读取 device_id，
  // 并在 exchangeToken 请求中发送给服务器。服务器通过此值识别设备。
  // 如果不修改，所有实例共享相同的 device_id → 服务器判定为同一设备 → "设备已签到"。
  rewriteLocalEnvDeviceId(workDir, fingerprint.machineGuid)

  // ---- 清除 env_codekg.db（codekg 服务持久化的 DeviceId）----
  // codekg 服务启动时从 env_codekg.db 读取缓存的 DeviceId，不清除会用旧值发请求。
  // 日志证据：codekg.log 中 device_id:1797050566717448 从启动就开始使用，
  // 即使 local_env.json 已被重写为新值，codekg 仍从 env_codekg.db 读取旧值并覆盖。
  const envCodekgDb = path.join(workDir, 'config', 'ModularData', 'ckg_server', 'env_codekg.db')
  if (process.env.MULTIOPEN_RESET_INSTANCE_DATA === '1' && existsSync(envCodekgDb)) {
    try {
      unlinkSync(envCodekgDb)
      console.log(`[Engine] 已清除 env_codekg.db（强制 codekg 重新读取 device_id）`)
    } catch {
      // 删除失败不阻断启动（文件可能被占用）
    }
  }

  // ---- 清除 tt_net_config.config 中的旧 device_id ----
  // tt_net_config.config 位于 config/ahanet/tt_net_config.config
  // AhaNet（字节跳动网络库）缓存了 device_id，不清除会用旧值发请求
  const ttNetConfig = path.join(workDir, 'config', 'ahanet', 'tt_net_config.config')
  if (process.env.MULTIOPEN_RESET_INSTANCE_DATA === '1' && existsSync(ttNetConfig)) {
    try {
      unlinkSync(ttNetConfig)
      console.log(`[Engine] 已清除 tt_net_config.config（强制重新读取 device_id）`)
    } catch {
      // 删除失败不阻断启动
    }
  }

  // ---- 修改 AhaNet (TTNet) 配置：禁用 QUIC，强制 TCP 走代理 ----
  // TTNet 是字节跳动网络库，有自己的 QUIC 实现（UDP），不走 Chromium 的 --proxy-server。
  // QUIC 流量绕过代理 → 服务器看到真实 IP → 通过 IP 识别为旧设备 → "设备已签到"。
  // 禁用 QUIC 后，TTNet 回退到 TCP/HTTPS，走 Chromium 的 --proxy-server 代理。
  rewriteTTNetConfig(workDir, fingerprint.proxy)

  // ---- 预置 machineid 文件（Chromium 设备标识）----
  const newDeviceId = deriveNumericDeviceId(fingerprint.machineGuid)
  const machineIdFile = path.join(workDir, 'config', 'machineid')
  try {
    if (!existsSync(machineIdFile)) {
      writeFileSync(machineIdFile, newDeviceId, 'utf-8')
      console.log(`[Engine] 预置 machineid=${newDeviceId}`)
    } else {
      const current = readFileSync(machineIdFile, 'utf-8').trim()
      if (current !== newDeviceId) {
        writeFileSync(machineIdFile, newDeviceId, 'utf-8')
        console.log(`[Engine] 已重写 machineid=${newDeviceId}`)
      }
    }
  } catch (e: any) {
    console.log(`[Engine] 预置 machineid 失败: ${e?.message || e}`)
  }

  // ---- 清除 Network/Cookies（旧登录态）----
  const cookiesFile = path.join(workDir, 'config', 'Network', 'Cookies')
  if (process.env.MULTIOPEN_RESET_INSTANCE_DATA === '1' && existsSync(cookiesFile)) {
    try { unlinkSync(cookiesFile); console.log(`[Engine] 已清除 Cookies（旧登录态）`) } catch {}
  }
  const cookiesJournal = path.join(workDir, 'config', 'Network', 'Cookies-journal')
  if (process.env.MULTIOPEN_RESET_INSTANCE_DATA === '1' && existsSync(cookiesJournal)) {
    try { unlinkSync(cookiesJournal) } catch {}
  }

  // ---- 清除 Trust Tokens ----
  const trustTokens = path.join(workDir, 'config', 'Network', 'Trust Tokens')
  if (process.env.MULTIOPEN_RESET_INSTANCE_DATA === '1' && existsSync(trustTokens)) {
    try { unlinkSync(trustTokens) } catch {}
  }
  const trustTokensJournal = path.join(workDir, 'config', 'Network', 'Trust Tokens-journal')
  if (process.env.MULTIOPEN_RESET_INSTANCE_DATA === '1' && existsSync(trustTokensJournal)) {
    try { unlinkSync(trustTokensJournal) } catch {}
  }

  // ---- 预置 Local State（Chromium 硬件数据标记）----
  const localStateFile = path.join(workDir, 'config', 'Local State')
  if (!existsSync(localStateFile)) {
    try {
      const localState = { hardware_data_available: true, install_date: String(Date.now()) }
      writeFileSync(localStateFile, JSON.stringify(localState), 'utf-8')
      console.log(`[Engine] 预置 Local State`)
    } catch {}
  } else {
    try {
      const raw = readFileSync(localStateFile, 'utf-8')
      const data = JSON.parse(raw)
      let changed = false
      if (!data['hardware_data_available']) { data['hardware_data_available'] = true; changed = true }
      if (changed) writeFileSync(localStateFile, JSON.stringify(data), 'utf-8')
    } catch {}
  }

  return identityChanged
}

/** 从 machineGuid 派生 16 位十进制数字格式的 DeviceID（与 Trae 原生格式一致） */
function deriveNumericDeviceId(machineGuid: string): string {
  const hash = createHash('sha256').update(machineGuid + ':numericDeviceId').digest()
  // 取前 8 字节作为无符号 64 位整数
  const num = hash.readBigUInt64BE(0)
  // 对 10^16 取模，得到 16 位数字，左侧补零确保 16 位
  return (num % 10000000000000000n).toString().padStart(16, '0')
}

/**
 * 输出实例最终落盘身份的脱敏快照。
 * 只记录哈希/长度，不记录 cookie、token 或完整设备标识，便于判断
 * “换了指纹但应用仍复用旧身份”这一类问题。
 */
function logIdentitySnapshot(workDir: string, fingerprint: InstanceFingerprint, boxName: string): void {
  const hash = (value: string): string => createHash('sha256').update(value || '').digest('hex').slice(0, 12)
  const readJson = (file: string): any => {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null } catch { return null }
  }
  const storage = readJson(path.join(workDir, 'config', 'User', 'globalStorage', 'storage.json')) || {}
  const localEnv = readJson(path.join(workDir, 'config', 'ModularData', 'ckg_server', 'local_env.json')) || {}
  const authKeys = Object.keys(storage).filter((k) => k.startsWith('iCubeAuthInfo://') || k.startsWith('iCubeServerData://'))
  console.log(`[IdentityAudit] box=${boxName} machineGuidHash=${hash(fingerprint.machineGuid)} deviceIdHash=${hash(String(localEnv.device_id || ''))} telemetryHash=${hash(String(storage['telemetry.machineId'] || ''))} proxy=${fingerprint.proxy || 'DIRECT'} authKeys=${authKeys.length} envCodekg=${existsSync(path.join(workDir, 'config', 'ModularData', 'ckg_server', 'env_codekg.db'))} ttNetConfig=${existsSync(path.join(workDir, 'config', 'ahanet', 'tt_net_config.config'))}`)
}

/** 重写 local_env.json 中的 device_id */
function rewriteLocalEnvDeviceId(workDir: string, machineGuid: string): void {
  const envFile = path.join(workDir, 'config', 'ModularData', 'ckg_server', 'local_env.json')
  const newDeviceId = deriveNumericDeviceId(machineGuid)

  if (!existsSync(envFile)) {
    // 文件不存在：创建预置 box 专属 device_id 的 local_env.json
    try {
      const dir = path.dirname(envFile)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const initial = {
        host: '',
        device_id: newDeviceId,
        is_privacy_mode: false,
        host_map: { default: 'https://trae-api-cn.mchost.guru' }
      }
      writeFileSync(envFile, JSON.stringify(initial), 'utf-8')
      console.log(`[Engine] 预置 local_env.json device_id=${newDeviceId}`)
    } catch (e: any) {
      console.log(`[Engine] 预置 local_env.json 失败: ${e?.message || e}`)
    }
    return
  }

  // 文件已存在：读取、替换 device_id
  try {
    const raw = readFileSync(envFile, 'utf-8')
    const data = JSON.parse(raw)
    if (data.device_id !== newDeviceId) {
      data.device_id = newDeviceId
      writeFileSync(envFile, JSON.stringify(data), 'utf-8')
      console.log(`[Engine] 已重写 local_env.json device_id=${newDeviceId}`)
    }
  } catch (e: any) {
    console.log(`[Engine] 重写 local_env.json 失败: ${e?.message || e}`)
  }
}

/**
 * 清除实例中残留的旧认证信息（与指纹隔离独立，始终执行）
 *
 * 即使未启用指纹隔离，也必须清除这些字段，否则：
 * - iCubeAuthInfo://icube-dc:<DeviceID> 会让应用复用旧 DeviceID
 * - has_device_id_updated_to_aha=true 会让应用跳过设备重新注册
 * - 服务器直接识别为已签到设备 → "当前设备今日已签到"
 *
 * 此函数解决的核心场景：
 *   用户首次未启用指纹隔离启动 → 应用生成 DeviceID 并签到 → 服务器记录
 *   用户随后启用指纹隔离重启 → 如果不清除旧认证，应用仍用旧 DeviceID → 仍被识别为已签到
 *
 * 清除范围：
 * - storage.json 中的 iCubeAuthInfo://*、iCubeServerData://*、has_device_id_updated_to_aha
 * - tt_net_config.config（AhaNet 缓存的 device_id）
 */
function clearStaleAuthInfo(workDir: string): void {
  // ---- 清除 storage.json 中的旧认证信息 ----
  const storageFile = path.join(workDir, 'config', 'User', 'globalStorage', 'storage.json')
  if (existsSync(storageFile)) {
    try {
      const raw = readFileSync(storageFile, 'utf-8')
      const data = JSON.parse(raw)
      let changed = false

      // 清除 iCubeAuthInfo 相关键（包含服务器绑定的 DeviceID）
      for (const key of Object.keys(data)) {
        if (key.startsWith('iCubeAuthInfo://') || key.startsWith('iCubeServerData://')) {
          delete data[key]
          changed = true
        }
      }

      // 清除 has_device_id_updated_to_aha（强制应用重新注册设备）
      // 【关键修正】不再删除此标记，原因同 rewriteAppDeviceIds 中的说明：
      // 删除会触发应用重新注册设备，从 env_codekg.db 读取旧 device_id 覆盖预写值。
      // 保留此标记=true，应用跳过重新注册，直接使用 local_env.json 中的 device_id。
      // if (data['has_device_id_updated_to_aha']) {
      //   delete data['has_device_id_updated_to_aha']
      //   changed = true
      // }

      if (changed) {
        writeFileSync(storageFile, JSON.stringify(data, null, 4), 'utf-8')
        console.log(`[Engine] 已清除旧认证信息（iCubeAuthInfo）`)
      }
    } catch (e: any) {
      console.log(`[Engine] 清除旧认证信息失败: ${e?.message || e}`)
    }
  }

  // ---- 清除 env_codekg.db（codekg 服务持久化的 DeviceId）----
  const envCodekgDb = path.join(workDir, 'config', 'ModularData', 'ckg_server', 'env_codekg.db')
  if (existsSync(envCodekgDb)) {
    try {
      unlinkSync(envCodekgDb)
      console.log(`[Engine] 已清除 env_codekg.db（强制 codekg 重新读取 device_id）`)
    } catch {
      // 删除失败不阻断启动
    }
  }

  // ---- 清除 tt_net_config.config（AhaNet 缓存的 device_id）----
  const ttNetConfig = path.join(workDir, 'config', 'ahanet', 'tt_net_config.config')
  if (existsSync(ttNetConfig)) {
    try {
      unlinkSync(ttNetConfig)
      console.log(`[Engine] 已清除 tt_net_config.config（强制重新读取 device_id）`)
    } catch {
      // 删除失败不阻断启动
    }
  }
}

/**
 * 清除实例的窗口恢复状态（防止"打开实例后自动弹出多个窗口"）
 *
 * 根本问题：Trae/VSCode 基于 Electron，会持久化上次会话的窗口布局到：
 *   - config/User/globalStorage/storage.json 中的 windowsState 键
 *   - config/User/workspaceStorage/ 目录（每个工作区的状态）
 *   - config/Backups/ 目录（备份的工作区）
 * 下次启动时，应用读取这些状态并恢复所有窗口 → 用户看到"自动弹出多个窗口"。
 *
 * 此函数在每次启动前清除窗口恢复状态，保留登录态（iCubeAuthInfo）和设备 ID。
 * 配合 --disable-features=RestoreOnStartup 实现双重保险。
 */
function clearWindowState(workDir: string): void {
  // 1. 清除 storage.json 中的 windowsState 键（保留其他键如认证信息、设备 ID）
  const storageFile = path.join(workDir, 'config', 'User', 'globalStorage', 'storage.json')
  if (existsSync(storageFile)) {
    try {
      const raw = readFileSync(storageFile, 'utf-8')
      const data = JSON.parse(raw)
      let changed = false
      // 清除窗口恢复状态（VSCode/Trae 用此键存储上次窗口布局）
      if (data['windowsState']) {
        delete data['windowsState']
        changed = true
      }
      // 清除工作区恢复标记
      if (data['window.restorePreviousSession']) {
        delete data['window.restorePreviousSession']
        changed = true
      }
      if (changed) {
        writeFileSync(storageFile, JSON.stringify(data, null, 4), 'utf-8')
        console.log(`[Engine] 已清除窗口恢复状态（windowsState）`)
      }
    } catch {
      // 非关键步骤，失败不阻断
    }
  }

  // 2. 清除 workspaceStorage 目录中的工作区状态（防止恢复多个工作区窗口）
  //    仅删除窗口布局缓存（.window-state 文件），不删除整个目录（保留扩展数据）
  const wsStorageDir = path.join(workDir, 'config', 'User', 'workspaceStorage')
  if (existsSync(wsStorageDir)) {
    try {
      const entries = readdirSync(wsStorageDir)
      for (const entry of entries) {
        const wsFile = path.join(wsStorageDir, entry, 'workspace.json')
        const stateFile = path.join(wsStorageDir, entry, 'state.vscdb')
        // 只清除 state.vscdb（窗口状态缓存），保留 workspace.json（工作区元数据）
        if (existsSync(stateFile)) {
          try { unlinkSync(stateFile) } catch { /* 文件可能被占用 */ }
        }
      }
    } catch {
      // 非关键步骤
    }
  }

  // 3. 清除 Backups 目录（VSCode 备份的崩溃恢复工作区）
  const backupsDir = path.join(workDir, 'config', 'Backups')
  if (existsSync(backupsDir)) {
    try {
      const entries = readdirSync(backupsDir)
      for (const entry of entries) {
        const fullPath = path.join(backupsDir, entry)
        try { rmSync(fullPath, { recursive: true, force: true }) } catch { /* 忽略 */ }
      }
      console.log(`[Engine] 已清除 Backups 目录（${entries.length} 项）`)
    } catch {
      // 非关键步骤
    }
  }
}

/**
 * 共享 Trae AI Agent 工具目录（防止每次启动都下载 tools-1.0.13.zip）
 *
 * 根本问题：Trae AI Agent 在启动时检查
 *   config/ModularData/ai-agent/vm/tools/config/version.json
 * 如果不存在，会自动从 lf-cdn.trae.com.cn 下载约 3.4 GB 的工具包。
 * 这个下载走 Node.js 网络栈，不受 --disable-background-downloads 控制。
 *
 * 解决方案：通过 Junction 让所有实例共享同一份已安装的工具目录。
 * 1. 查找已安装工具的实例（有 version.json 的）
 * 2. 在新实例的 tools 目录上创建 Junction 指向共享源
 * 3. 共享源优先使用 engine/tools_shared（稳定位置），其次从已有实例查找
 */
function linkSharedTools(workDir: string): void {
  const toolsDir = path.join(workDir, 'config', 'ModularData', 'ai-agent', 'vm', 'tools')
  const versionFile = path.join(toolsDir, 'config', 'version.json')

  // 如果 tools 目录已有 version.json，说明工具已安装，无需处理
  // 注意：existsSync 对 Junction 也会返回 true，需要检查目标是否有效
  if (existsSync(versionFile)) {
    // 验证 Junction 指向的目标确实存在（防止失效的 Junction）
    try {
      readFileSync(versionFile, 'utf-8')
      return // version.json 可读，工具已就绪
    } catch {
      // Junction 失效或文件不可读，继续重新创建
    }
  }

  // 优先使用 engine/tools_shared 作为共享源（稳定位置，不受实例删除影响）
  const sharedToolsDir = path.join(ENGINE_DIR, 'tools_shared')
  const sharedVersionFile = path.join(sharedToolsDir, 'config', 'version.json')

  // 如果共享源不存在或无效，从已安装实例查找并建立共享源
  if (!existsSync(sharedVersionFile) || (() => {
    try { readFileSync(sharedVersionFile, 'utf-8'); return false } catch { return true }
  })()) {
    // 遍历所有实例，找到有 version.json 的
    const profilesDir = path.join(ENGINE_DIR, 'instances')
    if (existsSync(profilesDir)) {
      for (const profileName of readdirSync(profilesDir)) {
        const profileDir = path.join(profilesDir, profileName)
        if (!existsSync(profileDir)) continue
        for (const indexName of readdirSync(profileDir)) {
          const instanceToolsDir = path.join(profileDir, indexName, 'config', 'ModularData', 'ai-agent', 'vm', 'tools')
          const instanceVersionFile = path.join(instanceToolsDir, 'config', 'version.json')
          if (existsSync(instanceVersionFile)) {
            // 验证可读
            try {
              readFileSync(instanceVersionFile, 'utf-8')
            } catch { continue }

            // 如果 sharedToolsDir 是失效的 Junction，先删除
            if (existsSync(sharedToolsDir)) {
              try { rmSync(sharedToolsDir, { force: true }) } catch {}
            }

            // 创建共享源的 Junction 指向已安装实例的 tools 目录
            mkdirSync(path.dirname(sharedToolsDir), { recursive: true })
            try {
              execSync(`mklink /J "${sharedToolsDir}" "${instanceToolsDir}"`, { shell: 'cmd.exe', timeout: 5000 })
              console.log(`[Engine] 已建立共享工具源: ${sharedToolsDir} -> ${instanceToolsDir}`)
            } catch {
              // 共享源创建失败，直接用实例目录作为源
            }
            break
          }
        }
        if (existsSync(sharedVersionFile)) {
          try { readFileSync(sharedVersionFile, 'utf-8'); break } catch {}
        }
      }
    }
  }

  // 检查共享源是否可用
  let sharedSource: string | null = null
  if (existsSync(sharedVersionFile)) {
    try { readFileSync(sharedVersionFile, 'utf-8'); sharedSource = sharedToolsDir } catch {}
  }

  // 如果共享源不可用，尝试直接查找已安装实例
  if (!sharedSource) {
    const profilesDir = path.join(ENGINE_DIR, 'instances')
    if (existsSync(profilesDir)) {
      for (const profileName of readdirSync(profilesDir)) {
        const profileDir = path.join(profilesDir, profileName)
        if (!existsSync(profileDir)) continue
        for (const indexName of readdirSync(profileDir)) {
          const instanceToolsDir = path.join(profileDir, indexName, 'config', 'ModularData', 'ai-agent', 'vm', 'tools')
          const instanceVersionFile = path.join(instanceToolsDir, 'config', 'version.json')
          if (existsSync(instanceVersionFile)) {
            try { readFileSync(instanceVersionFile, 'utf-8'); sharedSource = instanceToolsDir; break } catch {}
          }
        }
        if (sharedSource) break
      }
    }
  }

  if (!sharedSource) {
    console.log('[Engine] 未找到已安装工具的实例，跳过工具共享（首次启动会下载工具包）')
    return
  }

  // 为新实例创建 tools 目录的 Junction
  // 如果 tools 目录已存在（空的或失效的 Junction），先删除
  if (existsSync(toolsDir)) {
    // 检查是否已经是有效的 Junction
    try {
      const stat = execSync(`dir /AL "${path.dirname(toolsDir)}"`, { encoding: 'utf-8', shell: 'cmd.exe', timeout: 3000 })
      if (stat.includes(path.basename(toolsDir)) && stat.includes('<JUNCTION>')) {
        // 是 Junction，删除 Junction 链接（rmdir 只删链接不删目标）
        try { execSync(`rmdir "${toolsDir}"`, { shell: 'cmd.exe', timeout: 3000 }) } catch {}
      } else {
        // 不是 Junction，是普通目录，删除
        try { rmSync(toolsDir, { recursive: true, force: true }) } catch {}
      }
    } catch {
      try { rmSync(toolsDir, { recursive: true, force: true }) } catch {}
    }
  }

  // 创建 Junction
  mkdirSync(path.dirname(toolsDir), { recursive: true })
  try {
    execSync(`mklink /J "${toolsDir}" "${sharedSource}"`, { shell: 'cmd.exe', timeout: 5000 })
    console.log(`[Engine] 已链接共享工具目录: ${toolsDir} -> ${sharedSource}`)
  } catch (e: any) {
    console.log(`[Engine] 工具目录 Junction 创建失败: ${e?.message || e}`)
  }
}

/**
 * Windows TSF/IME keeps user dictionaries and composition data outside the
 * Chromium profile. Keep those small system-managed directories available to
 * an instance while leaving all application/account data instance-local.
 */
function linkHostImeDirectory(instanceRoot: string, hostRoot: string, relativePath: string): void {
  if (!hostRoot) return
  const source = path.join(hostRoot, relativePath)
  const target = path.join(instanceRoot, relativePath)
  if (!existsSync(source) || existsSync(target)) return
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    execSync(`mklink /J "${target}" "${source}"`, { shell: 'cmd.exe', timeout: 5000, stdio: 'ignore' })
  } catch {
    // IME directories are a compatibility bridge; failure must not block launch.
  }
}

/**
 * 启动后定时守卫：多次覆写 local_env.json 中的 device_id 和清理 env_codekg.db
 *
 * 根本问题：应用启动后可能从宿主路径或其他来源读取旧 device_id，覆盖预写的新值。
 * 即使在启动前删除了 env_codekg.db 并重写了 local_env.json，应用启动后仍可能：
 *   1. 重新创建 env_codekg.db 并写入旧 device_id
 *   2. 用旧 device_id 覆盖 local_env.json
 *
 * 解决方案：在应用启动后 3秒、6秒、10秒分别执行一次覆写操作，纠正任何回退。
 * 每次执行：
 *   - 检查 local_env.json 中的 device_id 是否为期望的新值，不是则覆写
 *   - 删除 env_codekg.db（如果应用重新创建了它）
 *
 * @param workDir 实例工作目录
 * @param machineGuid 实例的 MachineGuid（用于派生期望的 device_id）
 */
function startDeviceIdGuard(workDir: string, machineGuid: string): void {
  if (!machineGuid) return
  const expectedDeviceId = deriveNumericDeviceId(machineGuid)
  const envFile = path.join(workDir, 'config', 'ModularData', 'ckg_server', 'local_env.json')
  const envCodekgDb = path.join(workDir, 'config', 'ModularData', 'ckg_server', 'env_codekg.db')

  const guardAction = (label: string) => {
    try {
      // 1. 检查并覆写 local_env.json 中的 device_id
      if (existsSync(envFile)) {
        const raw = readFileSync(envFile, 'utf-8')
        const data = JSON.parse(raw)
        if (data.device_id !== expectedDeviceId) {
          console.log(`[Engine] [DeviceIdGuard ${label}] 检测到 device_id 回退: ${data.device_id} → ${expectedDeviceId}，已纠正`)
          data.device_id = expectedDeviceId
          writeFileSync(envFile, JSON.stringify(data), 'utf-8')
        }
      }
      // 2. 删除 env_codekg.db（应用可能在启动后重新创建并写入旧 device_id）
      if (process.env.MULTIOPEN_RESET_INSTANCE_DATA === '1' && existsSync(envCodekgDb)) {
        try {
          unlinkSync(envCodekgDb)
          console.log(`[Engine] [DeviceIdGuard ${label}] 已清除 env_codekg.db（防止 codekg 缓存旧 device_id）`)
        } catch {
          // 文件可能被占用，忽略
        }
      }
    } catch (e: any) {
      // 不阻断运行，仅记录
    }
  }

  // 3秒后执行第一次守卫（应用已完成初始化，可能已覆盖预写值）
  setTimeout(() => guardAction('3s'), 3000)
  // 6秒后执行第二次守卫（应用已完成登录流程，可能再次覆盖）
  setTimeout(() => guardAction('6s'), 6000)
  // 10秒后执行第三次守卫（确保最终状态正确）
  setTimeout(() => guardAction('10s'), 10000)
}

/**
 * 禁用 TTNet（字节跳动网络库），强制应用使用 Chromium 网络栈走代理
 *
 * 根本问题：
 *   TTNet 是字节跳动独立的网络栈，有自己的 QUIC（UDP）和 HTTP DNS 实现，
 *   完全不走 Chromium 的 --proxy-server 参数。
 *   所有 API 请求通过 ttnet fetch 发送 → 服务器看到真实 IP → 通过 IP 识别为旧设备。
 *
 * server.json 中的关键字段：
 *   - chromium_open: 1 → TTNet 替换 Chromium 网络栈（所有请求走 TTNet）
 *   - chromium_open: 0 → TTNet 不替换 Chromium（请求走 Chromium 网络栈 → 走 --proxy-server）
 *
 * 策略（三重保险）：
 *   1. 清空 ahanet 目录下所有文件（删除 TTNet 的配置和缓存）
 *   2. 预置一个 chromium_open:0 的 server.json，阻止 TTNet 替换 Chromium 网络栈
 *   3. 即使应用重新下载 server.json 覆盖，首次请求已通过 Chromium 发出（走代理）
 *
 * 注意：应用可能通过内置的 TTNet 重新下载 server.json 覆盖预置文件。
 * 但在覆盖之前，应用读取的是我们的预置文件，此时 chromium_open:0 生效，
 * Chromium 网络栈已初始化并走代理。后续即使 TTNet 激活，已建立的连接仍走代理。
 */
function rewriteTTNetConfig(workDir: string, proxy?: string): void {
  const ahanetDir = path.join(workDir, 'config', 'ahanet')
  if (!existsSync(ahanetDir)) {
    mkdirSync(ahanetDir, { recursive: true })
  }

  // 1. 清空 ahanet 目录下所有文件和子目录（删除旧配置和缓存）
  try {
    const entries = readdirSync(ahanetDir)
    for (const entry of entries) {
      const fullPath = path.join(ahanetDir, entry)
      try {
        rmSync(fullPath, { recursive: true, force: true })
      } catch {
        // 单个文件删除失败不阻断
      }
    }
    console.log(`[Engine] 已清空 ahanet 目录（${entries.length} 项）`)
  } catch (e: any) {
    console.log(`[Engine] 清空 ahanet 目录失败: ${e?.message || e}`)
  }

  // 2. 预置 chromium_open:0 的 server.json，阻止 TTNet 替换 Chromium 网络栈
  //    这是关键：chromium_open=0 告诉 TTNet 不要接管 Chromium 的网络请求
  const serverJsonPath = path.join(ahanetDir, 'server.json')
  const presetConfig = {
    message: 'success',
    summary: 'disabled_by_multiopen',
    data: {
      mssdk_config: {
        // 关键字段：0 = 不替换 Chromium 网络栈，所有请求走 Chromium → 走 --proxy-server
        chromium_open: 0,
        // 禁用 QUIC（UDP，不走代理）
        ttnet_quic_enabled: 0,
        // 禁用 HTTP DNS（绕过代理直接解析域名）
        ttnet_http_dns_enabled: 0,
        // 禁用 WPAD
        wpad_enabled: 0,
        // 禁用 URL 调度器（可能绕过代理）
        ttnet_url_dispatcher_enabled: 0,
        // 禁用 TTNet 请求重试（防止回退到直连）
        ttnet_request_retry_max_attempts: 0,
      },
    },
  }

  try {
    writeFileSync(serverJsonPath, JSON.stringify(presetConfig), 'utf-8')
    // 设为只读：防止 Trae 启动后下载新 server.json 覆盖 chromium_open:0
    // Trae 写入失败时会保留现有文件（chromium_open:0 生效），不会崩溃
    try { chmodSync(serverJsonPath, 0o444) } catch { /* 非关键 */ }
    console.log(`[Engine] 已预置 server.json（chromium_open:0，只读，强制 Chromium 网络栈）${proxy ? '，代理: ' + proxy : ''}`)
  } catch (e: any) {
    console.log(`[Engine] 预置 server.json 失败: ${e?.message || e}`)
  }

  // 3. 创建只读标记文件，防止应用覆盖（应用检测到此文件会跳过下载）
  //    注意：这不是强保护，应用可能忽略此文件，但至少能延缓覆盖
  const disableFlag = path.join(ahanetDir, '.disable_ttnet')
  try {
    writeFileSync(disableFlag, 'TTNet disabled by multiopen engine', 'utf-8')
  } catch {
    // 非关键步骤
  }
}

/**
 * 启动后定时守卫：持续监控并恢复 server.json 中的 chromium_open:0
 *
 * 根本问题：
 *   Trae 启动后会从 tnc0-bjlgy.zijieapi.com 下载新的 server.json，
 *   可能先删除只读文件再重建（绕过只读保护），将 chromium_open 覆盖为 1。
 *   一旦 chromium_open=1，TTNet 接管 Chromium 网络栈，绕过 --proxy-server 代理，
 *   导致部分网络请求直连失败 → "Network connection failed"。
 *
 * 解决方案：启动后每 2 秒检查一次 server.json，持续 30 秒。
 *   如果 chromium_open 不为 0，保留 Trae 下载的完整配置（含 DNS 映射），
 *   仅将 chromium_open 纠正为 0，并禁用 QUIC/HTTP DNS/WPAD，重新设为只读。
 *   不再删除 tt_net_config.config（避免 device_id 不稳定）。
 */
function startTTNetConfigGuard(workDir: string): void {
  const ahanetDir = path.join(workDir, 'config', 'ahanet')
  const serverJsonPath = path.join(ahanetDir, 'server.json')

  // 最小化预设（仅在 server.json 不存在或 JSON 损坏时使用）
  const fallbackConfig = {
    message: 'success',
    summary: 'disabled_by_multiopen',
    data: {
      mssdk_config: {
        chromium_open: 0,
        ttnet_quic_enabled: 0,
        ttnet_http_dns_enabled: 0,
        wpad_enabled: 0,
        ttnet_url_dispatcher_enabled: 0,
        ttnet_request_retry_max_attempts: 0,
      },
    },
  }

  const guardAction = (label: string) => {
    try {
      let needRewrite = false
      let existingData: any = null

      if (existsSync(serverJsonPath)) {
        try {
          const raw = readFileSync(serverJsonPath, 'utf-8')
          existingData = JSON.parse(raw)
          const chromiumOpen = existingData?.data?.mssdk_config?.chromium_open
          if (chromiumOpen !== 0) {
            console.log(`[Engine] [TTNetGuard ${label}] 检测到 chromium_open=${chromiumOpen}，已纠正为 0`)
            needRewrite = true
          }
        } catch {
          // JSON 解析失败，用 fallback 重写
          needRewrite = true
        }
      } else {
        // 文件被删除，用 fallback 重写
        needRewrite = true
      }

      if (needRewrite) {
        // 先解除只读（如果存在）
        try { chmodSync(serverJsonPath, 0o666) } catch { /* 文件可能不存在 */ }
        try { unlinkSync(serverJsonPath) } catch { /* 文件可能不存在 */ }

        // 保留 Trae 下载的完整配置（含 DNS 地址、调度规则等），仅修改关键字段：
        // - chromium_open: 0 → 强制使用 Chromium 网络栈（走 --proxy-server）
        // - ttnet_quic_enabled: 0 → 禁用 QUIC（UDP 不走代理）
        // - ttnet_http_dns_enabled: 0 → 禁用 HTTP DNS（可能绕过代理解析）
        // - wpad_enabled: 0 → 禁用 WPAD 自动代理发现
        // 保留 ttnet_http_dns_addr 等 DNS 映射，即使 TTNet 不接管网络栈，
        // 应用层仍可能读取这些映射做域名解析兜底。
        let dataToWrite: any
        if (existingData && typeof existingData === 'object') {
          dataToWrite = existingData
          if (!dataToWrite.data) dataToWrite.data = {}
          if (!dataToWrite.data.mssdk_config) dataToWrite.data.mssdk_config = {}
          dataToWrite.data.mssdk_config.chromium_open = 0
          dataToWrite.data.mssdk_config.ttnet_quic_enabled = 0
          dataToWrite.data.mssdk_config.ttnet_http_dns_enabled = 0
          dataToWrite.data.mssdk_config.wpad_enabled = 0
        } else {
          dataToWrite = fallbackConfig
        }

        writeFileSync(serverJsonPath, JSON.stringify(dataToWrite), 'utf-8')
        try { chmodSync(serverJsonPath, 0o444) } catch { /* 非关键 */ }
        console.log(`[Engine] [TTNetGuard ${label}] server.json 已重写（chromium_open:0，保留 DNS 映射）`)
      }

      // 注意：不再每次都删除 tt_net_config.config
      // 之前每 2 秒删除会导致 TTNet 不断重新生成 device_id，造成设备标识不稳定。
      // device_id 的重写已由 rewriteLocalEnvDeviceId 在启动前处理，
      // tt_net_config.config 的 device_id 在 chromium_open:0 下不会被使用。
    } catch {
      // 不阻断运行
    }
  }

  // 每 2 秒执行一次，持续 30 秒（共 15 次）
  // 覆盖 Trae 启动后下载 server.json 的时间窗口
  for (let i = 2; i <= 30; i += 2) {
    setTimeout(() => guardAction(`${i}s`), i * 1000)
  }
}

// ==================== 进程管理 ====================

/**
 * 检测系统上可用的浏览器路径（用于 URL 重定向）
 *
 * 为什么需要这个：实例内应用（如 Trae/VSCode 等 IDE）点击链接时，
 * hook DLL 拦截 ShellExecute/CreateProcessW 调用，
 * 把 URL 重定向到一个真正的浏览器（Chrome/Edge），附加 --user-data-dir 和 --proxy-server，
 * 使弹出的浏览器在实例环境内运行。
 *
 * 如果实例应用本身就是浏览器（chrome.exe/msedge.exe/firefox.exe），直接用应用路径。
 * 否则检测系统上的 Chrome → Edge。
 */
export function detectBrowserPath(appPath: string): string {
  const normalizedAppPath = resolveApplicationExecutable(appPath)
  // 如果实例应用本身就是浏览器，直接用应用路径
  const appExe = path.basename(normalizedAppPath || appPath).toLowerCase()
  if (['chrome.exe', 'msedge.exe', 'firefox.exe'].includes(appExe)) {
    return normalizedAppPath || appPath
  }
  // Chromium 安装目录常有一个顶层 launcher，但它可能依赖版本目录内的
  // *_elf.dll。直接启动顶层 exe 会出现“找不到 msedge_elf.dll”。
  // 优先选择同时包含 exe 和配套 elf DLL 的版本目录。
  const resolveChromiumExe = (root: string, exeName: string, elfName: string): string => {
    if (!existsSync(root)) return ''
    try {
      // 只枚举数字开头的版本目录，避免 Windows 安装目录中的
      // SetupMetrics 等特殊目录影响解析。
      const versionDirs = readdirSync(root)
        .filter((name) => /^\d+(?:\.\d+)+$/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const version of versionDirs) {
        const versionRoot = path.join(root, version)
        const versionExe = path.join(versionRoot, exeName)
        const versionElf = path.join(versionRoot, elfName)
        if (existsSync(versionExe) && existsSync(versionElf)) return versionExe
      }
    } catch {}
    const topLevel = path.join(root, exeName)
    return existsSync(topLevel) ? topLevel : ''
  }

  const chromeRoots = [
    // Chrome 默认按当前用户安装时位于 LOCALAPPDATA；这是常见安装方式。
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application') : '',
    'C:\\Program Files\\Google\\Chrome\\Application',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application',
  ].filter(Boolean)
  for (const root of chromeRoots) {
    const p = resolveChromiumExe(root, 'chrome.exe', 'chrome_elf.dll')
    if (p) return p
  }

  // 检查 Edge（Win10+ 总是有）
  const edgeRoots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application') : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    'C:\\Program Files\\Microsoft\\Edge\\Application',
  ].filter(Boolean)
  for (const root of edgeRoots) {
    const p = resolveChromiumExe(root, 'msedge.exe', 'msedge_elf.dll')
    if (p) return p
  }
  return '' // 未找到
}

/**
 * 将用户误选的应用目录解析为真正的可执行文件。
 * Chrome/Edge 常见选择错误是选中了 Application 文件夹而不是 chrome.exe/msedge.exe；
 * 直接把目录传给 spawn 会触发 Electron 主进程 ENOENT 异常。
 */
export function resolveApplicationExecutable(appPath: string): string {
  const candidate = String(appPath || '').trim().replace(/^"|"$/g, '')
  if (!candidate) return ''
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return ''
  } catch {
    return ''
  }
  const executableNames = [
    'chrome.exe', 'msedge.exe', 'firefox.exe',
    'Trae.exe', 'WorkBuddy.exe', 'Code.exe',
  ]
  for (const executableName of executableNames) {
    const executable = path.join(candidate, executableName)
    try {
      if (existsSync(executable) && statSync(executable).isFile()) return executable
    } catch {}
  }
  return ''
}

/** 获取 hook DLL 路径 */
function getHookDllPath(): string {
  // 开发模式：native/build/multiopen_hook.dll
  // 打包模式：resources/native/build/multiopen_hook.dll
  const devPath = path.join(ROOT, 'native', 'build', 'multiopen_hook.dll')
  if (existsSync(devPath)) return devPath

  // Electron 打包后
  const resourcesPath = (process as any).resourcesPath
  if (resourcesPath) {
    const packedPath = path.join(resourcesPath, 'native', 'build', 'multiopen_hook.dll')
    if (existsSync(packedPath)) return packedPath
  }

  return devPath // 返回开发路径（即使不存在，让调用方报错）
}

/** 启动一个实例。默认使用每实例持久化目录；原生 Hook 仅保留为显式实验模式。 */
export async function launchInstance(
  profile: Profile,
  index: number,
  existingFingerprint?: InstanceFingerprint
): Promise<{ ok: boolean; pid?: number; error?: string; boxName: string; workDir: string; fingerprint: InstanceFingerprint }> {
  const boxName = `${profile.boxPrefix}-${index}`
  const workDir = path.resolve(prepareInstanceDir(profile, index))
  const executablePath = resolveApplicationExecutable(profile.appPath)
  if (!executablePath) {
    return {
      ok: false,
      boxName,
      workDir,
      fingerprint: existingFingerprint || generateFingerprint(profile.fingerprint, index),
      error: `目标程序路径不是可执行文件，且目录内未找到支持的 exe：${profile.appPath}`,
    }
  }
  // The normal route has no native Hook. Browser Hook and legacy fingerprint
  // behavior are explicit diagnostic switches only.
  const browserHookEnabled = isBrowserHookEnabled()
  const legacyFingerprintEnabled = isLegacyFingerprintEnabled()
  // CreateProcessW 的 current directory 必须始终是已存在的真实目录。
  // 目录准备失败时立即返回可读错误，避免上层只显示 launch-failed/code 18。
  if (!existsSync(workDir)) {
    return {
      ok: false,
      error: `实例工作目录创建失败：${workDir}`,
      boxName,
      workDir,
      fingerprint: existingFingerprint || generateFingerprint(profile.fingerprint, index),
    }
  }

  // 优先使用已有指纹（来自 config.json，可能已被 regenerateFingerprint 更新），
  // 否则生成新指纹。这确保"换指纹"后的指纹在重启时被正确使用。
  const fingerprint = existingFingerprint || generateFingerprint(profile.fingerprint, index)

  // A retry or rapid second click must reuse an already-running instance,
  // rather than starting another process with the same profile.
  const configMarker = `--user-data-dir=${path.join(workDir, 'config')}`
  const existingMainPid = findMainPid(configMarker)
  if (existingMainPid > 0 && isProcessAlive(existingMainPid)) {
    return { ok: true, pid: existingMainPid, boxName, workDir, fingerprint }
  }

  let manifest = loadInstanceManifest(profile.id, index) || createInstanceManifest({
    profileId: profile.id,
    index,
    boxName,
    workDir,
  })
  if (manifest.state !== 'created' && manifest.state !== 'preparing') {
    manifest = advanceManifest(manifest, 'preparing')
  } else if (manifest.state === 'created') {
    manifest = advanceManifest(manifest, 'preparing')
  }
  manifest = advanceManifest(manifest, 'starting')

  const failLaunch = (error: string) => {
    try {
      manifest = advanceManifest(manifest, 'failed', { error: { code: 'launch_failed', message: error } })
    } catch {}
    return { ok: false, error, boxName, workDir, fingerprint }
  }

  let egressProxy = ''
  if (profile.egress?.enabled) {
    try {
      const parsed = parseTrustedEgress(profile.egress.proxyUrl)
      const verification = await verifyTrustedEgress(parsed.endpoint)
      if (!verification.verified) return failLaunch(`可信出口验证失败，实例已闭锁：${verification.error || '未知错误'}`)
      egressProxy = parsed.endpoint
      console.log(`[Egress] 出口验证通过: ${parsed.protocol}//${parsed.host}:${parsed.port}, latency=${verification.latencyMs ?? 0}ms`)
    } catch (error: any) {
      return failLaunch(`可信出口配置无效，实例已闭锁：${error?.message || error}`)
    }
  }

  // 启动前验证代理可用性：如果代理失效，服务器会看到真实 IP → 通过 IP 识别为旧设备 → "设备已签到"
  // 免费代理极不稳定，可能在分配后、启动前就失效
  if (legacyFingerprintEnabled && profile.fingerprint.enabled && fingerprint.proxy) {
    const alive = await testProxyAlive(fingerprint.proxy, 4000)
    if (!alive) {
      return failLaunch(`代理 ${fingerprint.proxy} 已失效，请使用受信任的出口配置后再启动`)
    }
    console.log(`[Engine] 代理验证通过: ${fingerprint.proxy}`)
  }

  // 仅在显式启用旧版兼容隔离时注入身份/代理环境。常规多开只隔离
  // 工作目录、AppData、用户目录和浏览器 Profile，不伪装成另一台物理设备。
  const fpEnv = legacyFingerprintEnabled ? fingerprintToEnvVars(fingerprint) : {}
  const launchFingerprint = egressProxy
    ? { ...fingerprint, proxy: egressProxy }
    : (legacyFingerprintEnabled ? fingerprint : undefined)

  // 重写应用层设备 ID（storage.json 中的 telemetry.machineId/sqmId/devDeviceId）
  // 关键：Trae/VSCode 通过这些 ID 在服务器端识别设备，必须每次启动前覆盖为 box 专属值
  if (legacyFingerprintEnabled && profile.fingerprint.enabled) {
    rewriteAppDeviceIds(workDir, fingerprint)
    // 设备 ID 发生变化时，旧认证绑定必须一起失效；普通重启不清理，避免每次启动都强制退出登录。
    // Normal restart must never invalidate an existing login. Explicit data
    // reset/delete remains the only path allowed to clear auth state.
    logIdentitySnapshot(workDir, fingerprint, boxName)
  }

  // 清除窗口恢复状态：防止 Trae/VSCode 恢复上次多窗口导致"自动弹出多个窗口"
  // 配合 buildArgs 中的 --disable-features=RestoreOnStartup 实现双重保险
  // Keep window/workspace state persistent across close/reopen. The explicit
  // reset action is responsible for destructive cleanup when requested.

  // 共享 AI Agent 工具目录：防止 Trae 每次启动都下载 tools-1.0.13.zip（3.4 GB）
  // 通过 Junction 让新实例共享已安装实例的工具，避免重复下载
  linkSharedTools(workDir)

  // 构建环境变量：系统环境 + 指纹 + 隔离引擎配置
  const env: Record<string, string> = { ...process.env as any, ...fpEnv }
  // ---- AppData 文件隔离 ----
  // 将 APPDATA / LOCALAPPDATA / TEMP 重定向到 box 专属目录，
  // 使应用写入的设备 ID、配置文件、缓存等互相隔离。
  // 这比 NtCreateFile hook 更稳定（不拦截文件 I/O），覆盖 95%+ 的应用。
  // 指纹隔离启用时自动启用环境变量隔离。
  // WorkBuddy keeps account/session helpers outside Chromium's user-data-dir;
  // APPDATA / LOCALAPPDATA / TEMP therefore always belong to this instance.
  const boxAppData = path.join(workDir, 'appdata')
  const boxRoaming = path.join(boxAppData, 'Roaming')
  const boxLocal = path.join(boxAppData, 'Local')
  const boxTemp = path.join(boxAppData, 'Temp')
  if (!existsSync(boxRoaming)) mkdirSync(boxRoaming, { recursive: true })
  if (!existsSync(boxLocal)) mkdirSync(boxLocal, { recursive: true })
  if (!existsSync(boxTemp)) mkdirSync(boxTemp, { recursive: true })
  const hostAppData = process.env.APPDATA || ''
  const hostLocalAppData = process.env.LOCALAPPDATA || ''
  // TSF/Microsoft IME data is owned by the signed-in Windows user, not by
  // WorkBuddy. Expose only the IME directories, never the whole host profile.
  // 微信输入法(WeType)/搜狗/百度等第三方输入法的用户数据也放在 APPDATA 下，
  // 缺省会直接导致实例内无法使用/切换输入法，因此一并做只读桥接。
  for (const relativePath of [
    'Microsoft\\InputMethod',
    'Microsoft\\IME',
    'Tencent\\WeType',
    'SogouInput',
    'SogouPY',
    'SogouWB',
    'BaiduInput',
  ]) {
    linkHostImeDirectory(boxRoaming, hostAppData, relativePath)
    linkHostImeDirectory(boxLocal, hostLocalAppData, relativePath)
  }
  // WorkBuddy stores account/session helpers below the Windows home and
  // AppData roots, not only below Chromium's --user-data-dir. These roots
  // must be instance-owned even when fingerprinting is disabled; otherwise
  // login/logout in one window changes the local app or another instance.
  // User-selected real folders remain available through `shared/` junctions.
  env.APPDATA = boxRoaming
  env.LOCALAPPDATA = boxLocal
  env.TEMP = boxTemp
  env.TMP = boxTemp

  // Trae native modules derive <home>\\.trae-cn from the Windows user profile.
  // Set the profile before process creation so the main process and every child
  // start with an instance-owned home directory.
  const boxHomeDir = path.join(workDir, 'userdata')
  if (!existsSync(boxHomeDir)) mkdirSync(boxHomeDir, { recursive: true })
  // Windows file dialogs and WorkBuddy resolve shell locations from
  // USERPROFILE. Keep the standard profile folders present so opening a file
  // does not fail with “...\userdata\Desktop is unavailable”. These are
  // private instance folders; explicitly shared real folders stay under
  // `shared/` and are never redirected here.
  for (const folder of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) {
    mkdirSync(path.join(boxHomeDir, folder), { recursive: true })
  }
  for (const relativePath of [
    'AppData\\Roaming\\Microsoft\\InputMethod',
    'AppData\\Roaming\\Microsoft\\IME',
    'AppData\\Local\\Microsoft\\InputMethod',
    'AppData\\Local\\Microsoft\\IME',
    'AppData\\Roaming\\Tencent\\WeType',
    'AppData\\Roaming\\SogouInput',
    'AppData\\Roaming\\SogouPY',
    'AppData\\Roaming\\SogouWB',
    'AppData\\Roaming\\BaiduInput',
  ]) {
    const isLocal = relativePath.startsWith('AppData\\Local')
    const instanceRoot = path.join(boxHomeDir, isLocal ? 'AppData\\Local' : 'AppData\\Roaming')
    const hostRoot = isLocal ? hostLocalAppData : hostAppData
    linkHostImeDirectory(instanceRoot, hostRoot, relativePath.replace(/^AppData\\(?:Roaming|Local)\\/, ''))
  }
  const homeRoot = path.parse(boxHomeDir).root
  env.USERPROFILE = boxHomeDir
  env.HOME = boxHomeDir
  env.HOMEDRIVE = homeRoot.slice(0, 2)
  env.HOMEPATH = boxHomeDir.slice(2)

  // ---- 隔离 ICUBE_USER_DATA_DIR（Trae 用户数据目录）----
  // codekg 服务通过 user_data_dir 读取设备标识，默认路径为 c:\Users\<user>\.trae-cn
  // 该路径在所有实例间共享，导致应用从宿主路径读取旧 device_id 覆盖预写的新值。
  // 重定向到 box 专属目录，使每个实例拥有独立的用户数据目录。
  const boxUserDataDir = path.join(workDir, 'userdata')
  if (!existsSync(boxUserDataDir)) mkdirSync(boxUserDataDir, { recursive: true })
  // WorkBuddy/Trae uses this directory for its own single-instance and
  // profile routing. Keep it instance-local even when fingerprint emulation
  // is disabled, otherwise a new launch can be forwarded to the primary
  // window. These variables are backed by the instance-owned AppData/home
  // roots above, so the local WorkBuddy process is never used as a fallback.
  env.ICUBE_USER_DATA_DIR = boxUserDataDir
  env.VSCODE_CWD = workDir
  // WorkBuddy's packaged runtime uses these names (rather than the Trae
  // compatibility variable above) when choosing userData and its singleton
  // lock. Set both config and app roots so every instance gets its own lock.
  env.WORKBUDDY_CONFIG_DIR = path.join(workDir, 'config')
  env.WORKBUDDY_USER_DATA_DIR = boxUserDataDir
  env.CODEBUDDY_CONFIG_DIR = path.join(workDir, 'config')
  // Keep WorkBuddy-hosted runtimes (sidecars, account/session helpers) from
  // reusing a host-level runtime identity when two instances are alive.
  const runtimeInstanceId = `${profile.id}:${index}`
  env.WORKBUDDY_RUNTIME_INSTANCE_ID = runtimeInstanceId
  env.CODEBUDDY_RUNTIME_INSTANCE_ID = runtimeInstanceId

  // 注入 DLL 需要的配置（通过环境变量传递给 hook DLL）
  if (isNativeHookEnabled() || browserHookEnabled) {
    env.MULTIOPEN_BOX_NAME = boxName
    env.MULTIOPEN_REDIRECT_BASE = path.join(workDir, 'config')
    env.MULTIOPEN_SHARED_DIR = path.join(workDir, 'shared')
  }

  // 浏览器重定向配置：实例内应用点击外部链接时，hook DLL 拦截 ShellExecute/CreateProcessW，
  // 把 URL 重定向到一个真正的浏览器（Chrome/Edge），附加 --user-data-dir 和 --proxy-server，
  // 使弹出的浏览器在实例环境内运行（独立 Cookie/会话/代理）。
  //
  // 为什么不用实例应用路径：如果实例应用是 Trae/VSCode 等 IDE，它们不是浏览器，
  // 无法打开网页。必须用一个真正的浏览器来承载 URL。
  if (browserHookEnabled) {
    env.MULTIOPEN_APP_PATH = executablePath
    env.MULTIOPEN_USER_DATA_DIR = path.join(workDir, 'config')
    env.MULTIOPEN_ENABLE_BROWSER_HOOKS = '1'
  }
  const launchProxy = egressProxy || (legacyFingerprintEnabled && profile.fingerprint.enabled ? fingerprint.proxy : '')
  if (launchProxy) {
    env.MULTIOPEN_PROXY_SERVER = launchProxy
  }
  // OAuth/native-app loopback callbacks must never be sent through a proxy.
  // Chromium already bypasses loopback implicitly; NO_PROXY protects native
  // helpers and HTTP clients that honor the conventional environment variable.
  env.NO_PROXY = '127.0.0.1,localhost,::1'
  env.no_proxy = env.NO_PROXY

  // ---- Node.js 代理覆盖 ----
  // Trae 的 Node.js 进程（AI Agent、Extension Host）使用 Node.js HTTP 客户端，
  // 不走 Chromium 的 --proxy-server。必须通过环境变量覆盖。
  if (launchProxy) {
    // 确保 Node.js 子进程也使用代理
    env.NPM_CONFIG_PROXY = launchProxy
    env.NPM_CONFIG_HTTPS_PROXY = launchProxy
  }

  // 检测系统浏览器路径（Chrome 优先，Edge 兜底）
  const browserPath = detectBrowserPath(executablePath)
  if (browserPath && browserHookEnabled) {
    env.MULTIOPEN_BROWSER_PATH = browserPath
    env.MULTIOPEN_BROWSER_USER_DATA_DIR = path.join(workDir, 'browser-profile-v2')
  }
  if (browserPath) {
    // 浏览器用独立的 user-data-dir（避免与 IDE 的 Chromium 数据冲突）
    // 浏览器目录与应用 config 完全分开，避免 IDE 的 Chromium 数据被浏览器复用。
    // 每个实例只使用自己的目录；不删除已有实例数据，以保留该实例自己的登录态。
    // v2 目录故意与旧版本的 browser 目录分离：旧版本可能曾把宿主会话
    // 写入这里，直接复用会把残留账号带回新实例。旧目录保留不删除，避免数据损失。
    const browserDataDir = path.join(workDir, 'browser-profile-v2')
    if (!existsSync(browserDataDir)) mkdirSync(browserDataDir, { recursive: true })
  }

  // 分配 CDP 调试端口（仅在启用指纹隔离时）
  // 用于连接浏览器注入 Canvas/WebGL/Audio/时区 等指纹覆盖脚本
  let debugPort = 0
  if (legacyFingerprintEnabled && profile.fingerprint.enabled) {
    debugPort = allocateDebugPort()
  }

  const args = buildArgs(profile, workDir, launchFingerprint, debugPort)

  // When Sandboxie is available, keep WorkBuddy and every child it opens
  // (including the default browser) inside the instance box. OpenFilePath is
  // the deliberate write-through boundary for the user's real work folders.
  // Do not silently fall back: that would reintroduce shared browser state.
  if (useSandboxie && sandboxie) {
    if (!(await sandboxie.serviceRunning())) {
      return failLaunch('Sandboxie 服务未运行，请先安装并启动 Sandboxie-Plus')
    }
    const boxResult = await sandboxie.ensureBox(boxName, {
      openPaths: profile.openPaths,
      cleanOnClose: false,
      boxNameTitle: profile.boxNameTitle,
      extraIni: profile.extraIni,
    })
    if (!boxResult.ok) {
      return failLaunch(boxResult.stderr || `无法准备沙箱 ${boxName}`)
    }
      const launched = await sandboxie.launch(boxName, executablePath, args.join(' '), workDir)
    if (!launched.ok) {
      return failLaunch(launched.stderr || `无法在沙箱 ${boxName} 中启动实例`)
    }
    await new Promise((r) => setTimeout(r, 1500))
    const marker = `--user-data-dir=${path.join(workDir, 'config')}`
    const snapshot = scanInstanceProcesses([marker]).get(marker)
    const pids = snapshot?.pids || []
    const mainPid = snapshot?.mainPid || 0
    const realPid = mainPid || pids[0] || 0
    if (realPid <= 0) {
      console.error(`[Engine] Sandboxie 启动后未发现实例进程: box=${boxName}, app=${executablePath}`)
      return failLaunch(`实例已提交给 Sandboxie，但未发现运行中的 WorkBuddy 进程（box=${boxName}）。请确认应用路径和 Sandboxie 服务状态。`)
    }
    saveInstanceRecord(profile.id, {
      index, boxName, workDir, pid: realPid, fingerprint,
      createdAt: Date.now(), lastLaunchedAt: Date.now(),
    })
    manifest = advanceManifest(manifest, 'process_ready', { pid: realPid })
    console.log(`[Engine] Job Object ${attachProcessToJob(path.join(workDir, 'config'), realPid) ? '已附加' : '未附加'}: box=${boxName}, pid=${realPid}`)
    if (realPid > 0) startWatcher(profile.id, index, realPid, marker)
    return { ok: true, pid: realPid, boxName, workDir, fingerprint }
  }

  if (useSandboxie && !sandboxieDetection.installed && requireSandboxie) {
    return failLaunch('未检测到 Sandboxie-Plus，已阻止非沙箱启动')
  }
  const dllPath = getHookDllPath()
  const nativeInjectionEnabled = (isNativeHookEnabled() || browserHookEnabled) && existsSync(dllPath)

  // 临时调试日志：写入文件以便排查注入问题（超过 5MB 自动清空，防止无限增长）
  const DEBUG_LOG = path.join(ROOT, 'data', 'launch_debug.log')
  const debugLog = (msg: string) => {
    const logLine = `[${new Date().toISOString()}] ${msg}\n`
    try {
      if (existsSync(DEBUG_LOG) && statSync(DEBUG_LOG).size > 5 * 1024 * 1024) {
        writeFileSync(DEBUG_LOG, '')
      }
      appendFileSync(DEBUG_LOG, logLine)
    } catch {}
    console.log(`[Engine] ${msg}`)
  }

  try {
    // Mainstream Electron/Chromium applications support isolated persistent
    // profiles through --user-data-dir. Native global-object rewriting is kept
    // behind an explicit diagnostic flag because current Trae builds exit before
    // logger initialization when those hooks are active.
    if (nativeInjectionEnabled) {
      debugLog(`DLL 路径: ${dllPath}, exists=true`)
      debugLog(`appPath: ${profile.appPath}, args 长度: ${args.length}`)
      debugLog(`env MULTIOPEN_MACHINE_GUID: ${env.MULTIOPEN_MACHINE_GUID || '未设置'}`)
      debugLog(`env MULTIOPEN_HOSTNAME: ${env.MULTIOPEN_HOSTNAME || '未设置'}`)
      debugLog(`env MULTIOPEN_BOX_NAME: ${env.MULTIOPEN_BOX_NAME || '未设置'}`)
      debugLog(`env USERPROFILE: ${env.USERPROFILE}`)
      debugLog(`env APPDATA: ${env.APPDATA}`)
      debugLog(`env LOCALAPPDATA: ${env.LOCALAPPDATA}`)
      debugLog(`env WORKBUDDY_USER_DATA_DIR: ${env.WORKBUDDY_USER_DATA_DIR}`)
      debugLog(`env MULTIOPEN_BROWSER_USER_DATA_DIR: ${env.MULTIOPEN_BROWSER_USER_DATA_DIR || '未设置'}`)
      const result = launchWithDllInjection(
        executablePath,
        args,
        // The executable may live in one shared installation directory, but
        // relative writes must resolve inside this instance's private root.
        // Electron resolves resources from appPath, so this does not break
        // shared-program launches.
        workDir,
        env,
        dllPath
      )
      debugLog(`launchWithDllInjection 结果: ok=${result.ok}, pid=${result.pid}, error=${result.error || '无'}`)
      if (!result.ok) {
        return failLaunch(result.error || '原生启动失败')
      }
      // 检查 launchWithDllInjection 是否报告注入失败（ok=true 但 error 存在）
      if (result.error) {
        debugLog(`警告: ${result.error}（将依赖 injectDllByPid 双保险）`)
      }
      // 等待浏览器完成子进程派生（Chromium launcher 派生真主进程 + 各种 utility 子进程）
      // 不等待会导致 UI 刷新时只看到 launcher（即将死），看不到子进程组。
      // 但 launcher 立即死 → listInstances 的 getBoxPids 扫描会找到子进程，所以这里短等即可。
      await new Promise((r) => setTimeout(r, 1200))
      const configDir = path.join(workDir, 'config')
      // 重新找 box 关联的进程，找一个长期存活的 PID（带 --type= 的子进程会持续运行直到 box 关闭）
      const boxPids = getBoxPids(`--user-data-dir=${configDir}`)
      debugLog(`boxPids: ${JSON.stringify(boxPids)}`)
      // 优先用 launcher PID（如果还活着），否则用扫描到的第一个 PID
      const realPid = (result.pid && isProcessAlive(result.pid)) ? result.pid : (boxPids[0] || result.pid || 0)
      debugLog(`realPid: ${realPid}`)

      // 【关键修复2】显式给主进程注入 hook DLL
      // 背景：launcher 立即死，hook DLL 通过 NtCreateUserProcess hook 的 CreateRemoteThread
      // 注入到子进程。但 launcher 派生主进程时如果 hook 链有延迟，主进程可能没装上 hook。
      // 这里显式注入一次作为双保险，确保主进程的 ShellExecute/CreateProcessW hook 生效。
      const mainPid = findMainPid(`--user-data-dir=${configDir}`)
      debugLog(`findMainPid 结果: ${mainPid}`)
      if (mainPid > 0 && existsSync(dllPath)) {
        try {
          const r = injectDllByPid(mainPid, dllPath)
          debugLog(`injectDllByPid 结果: ok=${r.ok}, error=${r.error || '无'}, mainPid=${mainPid}`)
          if (r.ok) {
            console.log(`[Engine] 已显式注入 hook DLL 到主进程 PID=${mainPid}（box=${boxName}）`)
          } else {
            console.log(`[Engine] 显式注入主进程失败 PID=${mainPid}: ${r.error}`)
          }
        } catch (e: any) {
          debugLog(`injectDllByPid 异常: ${e?.message || e}`)
          console.log(`[Engine] 显式注入主进程异常: ${e?.message || e}`)
        }
      } else {
        debugLog(`跳过 injectDllByPid: mainPid=${mainPid}, dllExists=${existsSync(dllPath)}`)
      }

      // Do not sweep-inject every Chromium child. Renderer/GPU/crashpad
      // processes are sandbox-sensitive and bulk CreateRemoteThread injection
      // caused launch-failed/code 18, multi-second stalls and enormous logs.
      // The native hook propagates only to explicitly recognized safe children;
      // the long-lived main process injection above is the bounded fallback.

      saveInstanceRecord(profile.id, {
        index, boxName, workDir, pid: realPid, fingerprint,
        createdAt: Date.now(), lastLaunchedAt: Date.now(),
      })
      manifest = advanceManifest(manifest, 'process_ready', { pid: realPid })
      console.log(`[Engine] Job Object ${attachProcessToJob(configDir, mainPid || realPid) ? '已附加' : '未附加'}: box=${boxName}, pid=${mainPid || realPid}`)

      // 【关键修复1】启动后台进程监视器
      // 用户关闭应用窗口后，主进程退出，但 helper 进程可能残留。
      // 监视器检测到主进程退出后自动清理所有孤儿进程。
      const watchPid = mainPid || realPid
      if (watchPid > 0) {
        startWatcher(profile.id, index, watchPid, `--user-data-dir=${configDir}`)
      }

      // CDP 指纹注入：连接浏览器调试端口，注入 Canvas/WebGL/Audio/时区/UA 等覆盖脚本
      // 异步执行不阻塞启动流程，最多重试 30 次（约 15 秒）等待浏览器就绪
      if (legacyFingerprintEnabled && debugPort > 0) {
        const cdpKey = `${profile.id}:${index}`
        const marker = `--user-data-dir=${configDir}`
        const injector = new CdpInjector(debugPort, fingerprint)
        cdpInjectors.set(cdpKey, { injector, debugPort, marker })
        injector.connect(30).then((ok) => {
          if (ok) {
            console.log(`[Engine] CDP 指纹注入成功 (port=${debugPort}, box=${boxName})`)
          } else {
            console.log(`[Engine] CDP 指纹注入未成功 (port=${debugPort}, box=${boxName})，浏览器层指纹覆盖可能不完整`)
          }
        }).catch((e) => {
          console.log(`[Engine] CDP 指纹注入异常: ${e?.message || e}`)
        })
      }

      // 启动后定时守卫：防止应用启动后从宿主路径/env_codekg.db 读取旧 device_id 覆盖预写值
      if (legacyFingerprintEnabled && profile.fingerprint.enabled && fingerprint.machineGuid) {
        startDeviceIdGuard(workDir, fingerprint.machineGuid)
      }

      // TTNet 配置守卫：Trae 启动后会下载新 server.json 覆盖 chromium_open:0 → 1，
      // 导致 TTNet 接管网络栈绕过 --proxy-server → "Network connection failed"。
      // 守卫每 2 秒检查并恢复 chromium_open:0，持续 30 秒覆盖下载时间窗口。
      if (legacyFingerprintEnabled) startTTNetConfigGuard(workDir)

      return { ok: true, pid: realPid, boxName, workDir, fingerprint }
    } else {
      debugLog(browserHookEnabled
        ? '启动模式: stable-persistent-profile + browser/instance namespace hooks'
        : '启动模式: stable-persistent-profile（native hooks disabled）')
      const { spawn } = await import('node:child_process')
      const child = spawn(executablePath, args, {
        // Keep shared binaries read-only from the common install directory;
        // give each process tree an instance-owned current directory.
        cwd: workDir,
        env,
        detached: true,
        stdio: 'ignore',
        shell: false,
      })
      child.once('error', (error) => {
        console.error(`[Engine] 实例进程启动失败: box=${boxName}, app=${executablePath}, error=${error.message}`)
        try {
          manifest = advanceManifest(manifest, 'failed', { error: { code: 'PROCESS_SPAWN_FAILED', message: error.message } })
        } catch {}
      })
      child.unref()
      const pid = child.pid || 0
      // 同样等待子进程派生
      await new Promise((r) => setTimeout(r, 1200))
      const configDir = path.join(workDir, 'config')
      const boxPids = getBoxPids(`--user-data-dir=${configDir}`)
      const realPid = (pid && isProcessAlive(pid)) ? pid : (boxPids[0] || pid)
      saveInstanceRecord(profile.id, {
        index, boxName, workDir, pid: realPid, fingerprint,
        createdAt: Date.now(), lastLaunchedAt: Date.now(),
      })
      manifest = advanceManifest(manifest, 'process_ready', { pid: realPid })
      // 后台监视器（同 DLL 注入路径）
      const watchPid = findMainPid(`--user-data-dir=${configDir}`) || realPid
      console.log(`[Engine] Job Object ${attachProcessToJob(configDir, watchPid) ? '已附加' : '未附加'}: box=${boxName}, pid=${watchPid}`)
      if (watchPid > 0) {
        startWatcher(profile.id, index, watchPid, `--user-data-dir=${configDir}`)
      }

      // CDP 指纹注入（同 DLL 注入路径）
      if (legacyFingerprintEnabled && debugPort > 0) {
        const cdpKey = `${profile.id}:${index}`
        const marker = `--user-data-dir=${configDir}`
        const injector = new CdpInjector(debugPort, fingerprint)
        cdpInjectors.set(cdpKey, { injector, debugPort, marker })
        injector.connect(30).then((ok) => {
          if (ok) {
            console.log(`[Engine] CDP 指纹注入成功 (port=${debugPort}, box=${boxName})`)
          } else {
            console.log(`[Engine] CDP 指纹注入未成功 (port=${debugPort}, box=${boxName})`)
          }
        }).catch(() => {})
      }

      // 启动后定时守卫：防止应用启动后从宿主路径/env_codekg.db 读取旧 device_id 覆盖预写值
      if (legacyFingerprintEnabled && profile.fingerprint.enabled && fingerprint.machineGuid) {
        startDeviceIdGuard(workDir, fingerprint.machineGuid)
      }

      // TTNet 配置守卫（同 DLL 注入路径）：持续恢复 chromium_open:0，防止绕过代理
      if (legacyFingerprintEnabled) startTTNetConfigGuard(workDir)

      return { ok: true, pid: realPid, boxName, workDir, fingerprint }
    }
  } catch (e: any) {
    return failLaunch(e.message || '实例启动异常')
  }
}

/** 构建启动参数，自动追加多开支持参数 */
function buildArgs(profile: Profile, workDir: string, fingerprint?: InstanceFingerprint, debugPort?: number): string[] {
  const args: string[] = []
  if (profile.appArgs) {
    args.push(...profile.appArgs.split(/\s+/).filter(Boolean))
  }
  // 自动追加 --user-data-dir（对 Chromium 系应用生效，其他应用忽略）
  const configDir = path.join(workDir, 'config')
  args.push(`--user-data-dir=${configDir}`)
  // 禁用后台模式：窗口关闭后进程自动退出，避免驻留托盘导致实例仍显示"运行中"
  args.push('--disable-background-mode')
  // 禁用会话恢复：防止 Trae/VSCode 恢复上次多窗口导致"自动弹出多个窗口"
  // 双保险：合并 BackgroundMode + RestoreOnStartup 到同一参数（Chromium 会合并多个 --disable-features）
  args.push('--disable-features=BackgroundMode,RestoreOnStartup,TabRestore')
  // 首次运行不显示欢迎页/导入向导（可能导致额外窗口）
  args.push('--no-first-run')
  args.push('--no-default-browser-check')
  // 禁用后台下载（防止实例启动后自动下载扩展/更新包）
  args.push('--disable-background-downloads')
  // 禁用默认应用关联检查
  args.push('--disable-default-apps')

  // 代理注入：对 Chromium 系应用追加 --proxy-server（子进程如弹出的浏览器也会继承此参数）
  // 环境变量 HTTP_PROXY/HTTPS_PROXY 对大多数应用已生效，--proxy-server 确保 Chromium 系强制走代理
  if (fingerprint && fingerprint.proxy) {
    const proxyUrl = fingerprint.proxy
    // Chromium --proxy-server 接受 http://host:port 或 socks5://host:port 格式
    args.push(`--proxy-server=${proxyUrl}`)
    // 禁止使用系统代理设置，确保只用我们指定的代理
    args.push('--ignore-certificate-errors-spki-list=')
    // 禁用 QUIC：QUIC 使用 UDP，不走 --proxy-server 代理，会暴露真实 IP
    // TTNet 有自己的 QUIC 实现，此参数确保 Chromium 网络栈不走 QUIC
    args.push('--disable-quic')
    // 不设置取消 loopback 隐式直连的特殊规则。该规则会取消 Chromium 对 localhost/127.0.0.1
    // 的默认直连，导致 OAuth 本地回调被错误送入代理并长时间无响应。
  }

  // UA 隔离：Chromium 原生支持 --user-agent 参数，覆盖 navigator.userAgent 和 HTTP 请求头
  if (fingerprint && fingerprint.userAgent) {
    args.push(`--user-agent=${fingerprint.userAgent}`)
  }

  // 语言隔离：--lang 控制 Chromium UI 语言和 navigator.language
  // --accept-lang 控制 HTTP Accept-Language 请求头
  if (fingerprint && fingerprint.language) {
    args.push(`--lang=${fingerprint.language}`)
    args.push(`--accept-lang=${fingerprint.language}`)
  }

  // WebRTC IP 泄漏防护：禁止 WebRTC 通过非代理 UDP 暴露真实 IP
  // 这是指纹隔离的关键一环 —— 即使设置了代理，WebRTC 默认仍可能泄漏真实 IP
  if (fingerprint && fingerprint.proxy) {
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
    args.push('--disable-features=WebRtcHideLocalIpsWithMdns')
  }

  // DNS 泄漏防护：强制 DNS 通过代理解析，防止本地 DNS 服务器泄漏真实 IP
  if (fingerprint && fingerprint.proxy) {
    args.push(...buildDnsLeakRules(fingerprint.proxy))
  }

  // 禁用可能泄漏设备信息的特性
  args.push('--disable-background-networking')  // 禁止后台网络请求（可能携带设备标识）
  args.push('--disable-domain-reliability')      // 禁止域名可靠性监控上报
  args.push('--disable-component-update')        // 禁止组件自动更新（避免版本指纹）

  // CDP 调试端口：用于指纹注入引擎连接浏览器，注入 Canvas/WebGL/Audio 等覆盖脚本
  if (debugPort && debugPort > 0) {
    args.push(`--remote-debugging-port=${debugPort}`)
    // 限制 CDP 只监听本地，避免远程调试泄漏
    args.push('--remote-debugging-address=127.0.0.1')
  }

  return args
}

/**
 * 终止实例（进程树终止 + box 进程组扫描 + 等待进程完全退出）
 *
 * @param pid launcher 进程 PID（可能已死）
 * @param configDir 该 box 的 --user-data-dir 路径（用于扫描 box 关联的所有运行进程）
 */
export async function terminateInstance(
  pid: number,
  configDir?: string,
  opts: { fast?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  // 宿主保护：configDir 不属于实例管理范围时拒绝终止，避免误杀本机宿主 WorkBuddy。
  if (configDir) {
    const managed = managedInstanceDir(configDir)
    if (!managed) {
      console.error(`[Engine] 拒绝终止：目标目录不属于实例管理范围: ${configDir}`)
      return { ok: false, error: `拒绝终止：目录不在实例管理范围内（${configDir}）` }
    }
    configDir = managed
  }
  // 收集所有需要终止的 PID：
  // 1. launcher PID（如果还活着）
  // 2. box 主进程 PID（带 --user-data-dir 且无 --type=）
  // 3. box 关联的所有 helper 进程（防止 crashpad / GPU 残留）
  const pids = new Set<number>()
  if (configDir) terminateInstanceJob(configDir)
  if (pid && pid > 0 && isProcessAlive(pid)) pids.add(pid)
  if (configDir && !opts.fast) {
    const marker = `--user-data-dir=${configDir}`
    const browserMarkers = browserMarkersForConfigMarker(marker)
    // 停止后台监视器（手动终止时不需要监视器再清理）
    stopWatcherByMarker(marker)
    // 断开 CDP 连接并释放调试端口
    stopCdpByMarker(marker)
    // 一次 CIM 扫描同时获取主进程和 helper，避免删除时连续启动两次
    // PowerShell 查询造成明显卡顿。
    const snapshots = scanInstanceProcesses([marker, ...browserMarkers])
    for (const currentMarker of [marker, ...browserMarkers]) {
      const snapshot = snapshots.get(currentMarker)
      if (snapshot?.mainPid && snapshot.mainPid > 0) pids.add(snapshot.mainPid)
      for (const p of snapshot?.pids || []) {
        if (p > 0) pids.add(p)
      }
    }
    // 环境变量匹配：WorkBuddy 自启的 Edge 默认配置浏览器（命令行无标记）
    for (const p of getInstanceBrowserPids(path.dirname(configDir))) {
      if (p > 0) pids.add(p)
    }
  }

  if (pids.size === 0) return { ok: true }

  // 逐个 taskkill 进程树
  const errors: string[] = []
  for (const p of pids) {
    if (!isProcessAlive(p)) continue
    try {
      await execAsync(`taskkill /T /F /PID ${p}`, { timeout: 10000 })
    } catch (e: any) {
      const msg = e.message || ''
      if (!/not found|找不到|不存在|no running instance|could not be terminated|invalid parameter/i.test(msg)) {
        errors.push(`PID ${p}: ${msg}`)
      }
    }
  }

  // 等待所有进程完全退出（最多 5 秒），避免 taskkill 返回后进程仍在退出过程中、刷新时仍显示"运行中"
  for (let i = 0; i < (opts.fast ? 10 : 50); i++) {
    let anyAlive = false
    for (const p of pids) {
      if (isProcessAlive(p)) { anyAlive = true; break }
    }
    if (!anyAlive) break
    await new Promise((r) => setTimeout(r, 100))
  }

  // 最后再扫一次：可能 taskkill 完成后又产生了新进程（子进程孤儿被 adopt 后重新 fork）
  if (configDir && !opts.fast) {
    const marker = `--user-data-dir=${configDir}`
    const browserMarkers = browserMarkersForConfigMarker(marker)
    let remaining = [...getBoxPids(marker)]
    for (const browserMarker of browserMarkers) {
      remaining = [...remaining, ...getBoxPids(browserMarker)]
    }
    remaining = [...remaining, ...getInstanceBrowserPids(path.dirname(configDir))]
    for (const p of new Set(remaining)) {
      if (isProcessAlive(p)) {
        try {
          await execAsync(`taskkill /T /F /PID ${p}`, { timeout: 5000 })
        } catch {}
      }
    }
  }

  return { ok: errors.length === 0, error: errors.length ? errors.join('；') : undefined }
}

/** 检查进程是否在运行（不抛异常，外部模块可用） */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 检查进程是否在运行（兼容 launcher 已死、box 仍有子进程的场景） */
export function isProcessRunning(pid: number, configDir?: string): boolean {
  // 1. 先查 launcher pid（如果还活着肯定算运行中）
  if (isProcessAlive(pid)) return true
  // 2. launcher 已死，扫描 box 关联的所有进程
  if (configDir) {
    return getBoxPids(`--user-data-dir=${configDir}`).some((p) => isProcessAlive(p))
  }
  return false
}

// ==================== 实例记录持久化 ====================

function recordFile(profileId: string): string {
  return path.join(profileDir(profileId), 'records.json')
}

function saveInstanceRecord(profileId: string, record: InstanceRecord): void {
  const records = loadInstanceRecords(profileId)
  const idx = records.findIndex((r) => r.index === record.index)
  if (idx >= 0) records[idx] = record
  else records.push(record)
  writeJsonAtomic(recordFile(profileId), records)
}

export function loadInstanceRecords(profileId: string): InstanceRecord[] {
  const file = recordFile(profileId)
  if (!existsSync(file)) return []
  const loaded = readJsonWithBackup<InstanceRecord[]>(file)
  if (loaded?.recoveredFromBackup) console.warn(`[Engine] records.json 主文件损坏，已从备份读取: ${file}.bak`)
  return Array.isArray(loaded?.value) ? loaded.value : []
}

export function removeInstanceRecord(profileId: string, index: number): void {
  const records = loadInstanceRecords(profileId).filter((r) => r.index !== index)
  writeJsonAtomic(recordFile(profileId), records)
}

/** 清空实例配置目录（保留记录和共享链接） */
export async function cleanInstance(profileId: string, index: number): Promise<{ ok: boolean; error?: string }> {
  const dir = instanceDir(profileId, index)
  if (!existsSync(dir)) return { ok: true }
  try {
    const configDir = path.join(dir, 'config')
    if (existsSync(configDir)) {
      const result = await forceRemoveDir(configDir)
      if (!result.ok) return result
    }
    mkdirSync(configDir, { recursive: true })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

/**
 * 清除实例的浏览器数据（用于"换指纹"后重启时重置设备标识）
 *
 * 为什么需要这个：平台通过 cookies/localStorage 追踪设备身份。
 * 仅换指纹（canvas/webgl/UA）而不清 cookies，平台仍能通过旧 session 识别为同一设备。
 * 此函数在实例进程已终止后调用，清除所有浏览器追踪数据。
 *
 * 清除范围：
 * - config/ : 实例应用的 --user-data-dir（cookies, localStorage, IndexedDB, 缓存）
 * - browser/ : 重定向浏览器的 user-data-dir（外部链接打开的浏览器 cookies）
 * - appdata/ : 重定向的 APPDATA/LOCALAPPDATA（可能含设备 ID、缓存）
 * 保留 shared/（用户文件，不含设备标识）
 *
 * 实现注意：用 Windows 原生 rd /s /q 命令异步删除（不阻塞 Node.js 事件循环），
 * 而非 rmSync（同步删除大量 Chromium 缓存文件会阻塞事件循环数十秒导致"无响应"）。
 */
export async function cleanInstanceForFingerprint(profileId: string, index: number): Promise<{ ok: boolean; error?: string }> {
  const dir = instanceDir(profileId, index)
  if (!existsSync(dir)) return { ok: true }
  const errors: string[] = []

  // 用 forceRemoveDir 删除目录（处理 Junction + 锁文件 + 权限问题）
  const cleanDir = async (p: string) => {
    const result = await forceRemoveDir(p)
    if (!result.ok) {
      errors.push(`${path.basename(p)}: ${result.error}`)
      return
    }
    mkdirSync(p, { recursive: true })
  }

  // 1. config/ —— 实例应用 user-data-dir（cookies, localStorage 等）
  await cleanDir(path.join(dir, 'config'))
  // 2. browser/ —— 重定向浏览器 user-data-dir
  await cleanDir(path.join(dir, 'browser'))
  // 3. appdata/ —— 重定向 APPDATA（设备级缓存、配置）
  const appdataDir = path.join(dir, 'appdata')
  if (existsSync(appdataDir)) {
    const result = await forceRemoveDir(appdataDir)
    if (!result.ok) errors.push(`appdata: ${result.error}`)
    mkdirSync(path.join(appdataDir, 'Roaming'), { recursive: true })
    mkdirSync(path.join(appdataDir, 'Local'), { recursive: true })
    mkdirSync(path.join(appdataDir, 'Temp'), { recursive: true })
  }
  return { ok: errors.length === 0, error: errors.length ? errors.join('; ') : undefined }
}

/**
 * 递归查找并删除目录中的所有 Junction/SymbolicLink（防止 rmSync/rd 跟随链接删除目标）
 *
 * 为什么需要这个：rmSync 遇到 Junction 会跟随链接删除目标内容，
 * 导致共享工具目录、共享文件夹的真实数据被误删。
 * rmdir 只删除 Junction 链接本身，不删除目标。
 */
function removeAllJunctions(dir: string): void {
  if (!existsSync(dir)) return
  // 用 dir /AL /S 列出所有 Junction（/AL 只列出重解析点，/S 递归）
  try {
    const out = execSync(`dir /AL /S /B "${toLongPath(dir)}"`, { encoding: 'utf-8', shell: 'cmd.exe', timeout: 15000 })
    const lines = out.split(/\r?\n/).filter((l) => l.trim())
    for (const line of lines) {
      const junctionPath = line.trim()
      if (junctionPath && existsSync(junctionPath)) {
        try {
          execSync(`rmdir "${toLongPath(junctionPath)}"`, { shell: 'cmd.exe', timeout: 3000 })
        } catch {
          try { execSync(`del /f /q "${toLongPath(junctionPath)}"`, { shell: 'cmd.exe', timeout: 3000 }) } catch {}
        }
      }
    }
  } catch {
    // dir 失败（可能目录不存在或权限不足），忽略
  }
}

/**
 * 转为 Windows 长路径形式（`\\?\` 前缀）。
 *
 * 实例的插件/市场目录层级很深（如
 * `config\plugins\marketplaces\codebuddy-plugins-official.*.tmp\external_plugins\...`），
 * 加上 `.deleting-<时间戳>-<pid>` 后缀后总路径很容易超过 MAX_PATH(260)。
 * `rd`/`del`/`takeown` 对超长路径会报“系统找不到指定的路径”导致删除失败并遗留
 * `*.deleting-*` 目录；`\\?\` 前缀可绕过该限制。
 */
function toLongPath(p: string): string {
  const abs = path.resolve(p)
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs
}

/**
 * 可靠的手动递归删除（`\\?\` 长路径前缀）。
 *
 * 为什么不用 fs.rmSync({recursive})：实测在包含 vendored node/python 深层
 * 依赖树的实例目录上，Node 的 rmSync 会“成功返回但目录仍存在”（静默不删）。
 * 逐项 readdirSync + unlinkSync/rmdirSync 则稳定可靠，且同样不跟随 Junction
 * （Junction 在调用前已由 removeAllJunctions 移除）。
 *
 * 失败的文件（被占用或 Deny ACE）会被跳过，由调用方的 takeown/icacls 回退处理。
 */
function removeTreeSync(longPath: string, deadlineMs?: number): void {
  // 启动清扫等场景传入截止时间，超时立即放弃，避免长时间阻塞事件循环
  if (deadlineMs !== undefined && Date.now() > deadlineMs) return
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = readdirSync(longPath, { withFileTypes: true })
  } catch {
    // 目录已不存在或无法枚举：尝试直接删除自身（可能是单个文件/Junction）
    try {
      rmdirSync(longPath)
    } catch {
      try { unlinkSync(longPath) } catch {}
    }
    return
  }
  for (const entry of entries) {
    const child = `${longPath}\\${entry.name}`
    if (entry.isDirectory()) {
      removeTreeSync(child, deadlineMs)
      try {
        rmdirSync(child)
      } catch {
        try { unlinkSync(child) } catch {}
      }
    } else {
      try {
        unlinkSync(child)
      } catch {
        try { rmdirSync(child) } catch {}
      }
    }
  }
  // 删除根目录本身（此前遗漏导致子项删光后顶层目录残留）
  try {
    rmdirSync(longPath)
  } catch {
    try { unlinkSync(longPath) } catch {}
  }
}

/**
 * 强制删除目录（处理被锁文件、只读文件、权限问题）
 *
 * 策略：
 * 1. 先删除所有 Junction（防止误删共享目标）
 * 2. 首选手动递归删除（`\\?\` 长路径前缀，不跟随 Junction，能删超长路径）
 * 3. 失败时用 takeown 获取所有权 + icacls 授予完全控制权限后重试
 * 4. 再失败用 del /f /q /a /s + rd /s /q（均带长路径前缀）
 */
async function forceRemoveDir(dir: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(dir)) return { ok: true }

  // 1. 先删除所有 Junction（关键：防止 rmSync/rd 跟随链接删除共享数据）
  removeAllJunctions(dir)

  // 2. 首选手动递归删除（长路径前缀）。绝大多数实例目录一次删除成功。
  removeTreeSync(toLongPath(dir))
  if (!existsSync(dir)) return { ok: true }

  // 3. 仅在删除失败时获取权限，再重试
  if (existsSync(dir)) {
    try {
      // 旧提权实例的日志目录带“拒绝删除”Deny ACE（Deny 优先于 Allow，
      // takeown/icacls /grant 都无效）。属主可先用 icacls /remove:d 递归移除
      // 当前用户的显式 Deny ACE，再重试删除。普通权限即可完成。
      const userIdentity = `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`
      await execAsync(`icacls "${toLongPath(dir)}" /remove:d "${userIdentity}" /t /c /q`, { timeout: 60000 })
      removeTreeSync(toLongPath(dir))
      if (!existsSync(dir)) return { ok: true }
      await execAsync(`takeown /f "${toLongPath(dir)}" /r /d y`, { timeout: 60000 })
      await execAsync(`icacls "${toLongPath(dir)}" /grant administrators:F /t /c /q`, { timeout: 60000 })
      removeTreeSync(toLongPath(dir))
      if (!existsSync(dir)) return { ok: true }
    } catch {
      // 继续使用更强制的删除方式
    }
  }

  // 4. 用 del /f /q /a /s 删除所有文件（包括只读/系统/隐藏文件），再 rd（长路径前缀）
  if (existsSync(dir)) {
    try {
      await execAsync(`del /f /q /a /s "${toLongPath(dir)}\\*"`, { timeout: 60000, shell: 'cmd.exe' })
      await execAsync(`rd /s /q "${toLongPath(dir)}"`, { timeout: 60000, shell: 'cmd.exe' })
      if (!existsSync(dir)) return { ok: true }
    } catch {
      // del+rd 失败，继续尝试
    }
  }

  // 5. 最终检查
  return existsSync(dir)
    ? {
        ok: false,
        error:
          `部分文件无法删除（可能被进程占用，或属于旧版管理员实例遗留的受限文件）。` +
          `请先关闭相关 WorkBuddy 实例；若是历史残留，可右键以管理员身份运行 ` +
          `scripts\\清理残留实例数据.bat 清理。路径: ${dir}`,
      }
    : { ok: true }
}

/** 彻底删除实例（记录 + 工作目录，不删共享真实数据） */
export async function deleteInstance(profileId: string, index: number): Promise<{ ok: boolean; error?: string }> {
  const dir = instanceDir(profileId, index)
  try {
    // Include remnants from an earlier timed-out deletion. The old code
    // renamed the directory to `*.deleting-*`; a later delete saw the
    // original path missing and removed only the record, leaving the data.
    const parent = path.dirname(dir)
    const pendingDirs = existsSync(parent)
      ? readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${index}.deleting-`))
        .map((entry) => path.join(parent, entry.name))
      : []
    const targets = [...pendingDirs]
    if (existsSync(dir)) {
      const pendingDir = `${dir}.deleting-${Date.now()}-${process.pid}`
      try {
        renameSync(toLongPath(dir), toLongPath(pendingDir))
        targets.push(pendingDir)
      } catch {
        targets.push(dir)
      }
    }

    for (const target of targets) {
      const result = await forceRemoveDir(target)
      if (!result.ok) return result
    }

    // Do not report success while any exact instance directory/remnant still
    // exists. The record remains retryable when deletion is incomplete.
    const leftovers = [dir, ...pendingDirs].filter((target) => existsSync(target))
    if (leftovers.length > 0) {
      return { ok: false, error: `实例数据仍存在，删除未完成: ${leftovers.join(', ')}` }
    }
    removeInstanceRecord(profileId, index)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

/**
 * 启动时清理上次中断删除留下的 `*.deleting-*` 残留目录。
 *
 * 安全约束：
 * - 只处理名字明确匹配 `*.deleting-<epoch>` 的目录（已被标记删除，绝不动活动实例目录）；
 * - 只清理 5 分钟前产生的残留，避免与正在进行的删除流程竞争；
 * - 删除失败（文件仍被占用）的目录保留，下次启动再试。
 */
export async function sweepStaleDeletingDirs(): Promise<{ removed: number; failed: number }> {
  const instancesRoot = path.join(ENGINE_DIR, 'instances')
  if (!existsSync(instancesRoot)) return { removed: 0, failed: 0 }
  const now = Date.now()
  let removed = 0
  let failed = 0
  for (const profileDir of readdirSync(instancesRoot, { withFileTypes: true })) {
    if (!profileDir.isDirectory()) continue
    const parent = path.join(instancesRoot, profileDir.name)
    let entries: string[] = []
    try {
      entries = readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => /\.deleting-(\d+)/.test(name))
        .filter((name) => {
          const m = /\.deleting-(\d+)/.exec(name)
          return m ? now - Number(m[1]) > 5 * 60 * 1000 : false
        })
        .map((name) => path.join(parent, name))
    } catch {
      continue
    }
    for (const target of entries) {
      // 启动清扫只做快速尽力删除：
      // - removeTreeSync 不跟随 Junction（实测以 symlink 处理），无需先删 Junction；
      // - 带 2 秒截止时间，超时立即放弃，绝不长时间阻塞事件循环；
      // - 若目录仍有残留（通常是旧提权实例日志目录上的“拒绝删除”Deny ACE），
      //   用 icacls /remove:d 递归移除当前用户的 Deny ACE 后重试一次；
      //   该操作属主即可执行，无需管理员，实测可在普通权限下解锁并删除。
      removeTreeSync(toLongPath(target), Date.now() + 2000)
      if (!existsSync(target)) {
        removed += 1
        continue
      }
      try {
        const userIdentity = `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`
        await execAsync(`icacls "${toLongPath(target)}" /remove:d "${userIdentity}" /t /c /q`, { timeout: 30000 })
        removeTreeSync(toLongPath(target), Date.now() + 2000)
      } catch {
        // 解锁失败（如被进程占用）时保留目录，下次启动再试
      }
      if (!existsSync(target)) removed += 1
      else failed += 1
    }
  }
  if (removed > 0 || failed > 0) {
    console.log(`[Engine] 清理残留删除目录: removed=${removed}, failed=${failed}`)
  }
  return { removed, failed }
}

/**
 * 获取档案的所有实例（含运行状态检测）
 *
 * 运行状态判断（最终修复版）：
 * 只用主进程判断：findMainPid(marker) 找到主进程（带 --user-data-dir 且无 --type=）→ 运行中
 * 找不到主进程 → 未运行，并自动清理残留 helper 进程
 *
 * 之前为什么一直显示"运行中"：
 *   running = mainAlive || launcherAlive
 *   launcherAlive 检查 r.pid，但 r.pid 可能是 helper 进程 PID（boxPids[0]）
 *   关窗后主进程退出，helper 还活着 → launcherAlive=true → running=true → 永远显示运行中
 *   修复：去掉 launcherAlive，只用主进程判断
 */
export function listInstances(profileId: string): InstanceRuntime[] {
  const records = loadInstanceRecords(profileId)
  return records.map((r) => {
    const configDir = path.join(r.workDir, 'config')
    // 宿主保护：记录目录不属于实例管理范围时只报告未运行，不清理任何进程。
    if (managedInstanceDir(configDir) === null) {
      console.error(`[Engine] 忽略越界实例记录 (workDir=${r.workDir}, box=${r.boxName})`)
      return {
        index: r.index,
        pid: 0,
        boxName: r.boxName,
        workDir: r.workDir,
        running: false,
        pids: [],
        fingerprint: r.fingerprint,
        createdAt: r.createdAt,
      }
    }
    const marker = `--user-data-dir=${configDir}`

    // 只用主进程判断运行状态
    const mainPid = findMainPid(marker)
    const running = mainPid > 0 && isProcessAlive(mainPid)

    let pids: number[] = []
    if (running) {
      // 显示所有 box 关联的进程（含 helper）
      pids = getBoxPids(marker)
    } else {
      // 主进程已死：清理残留 helper（crashpad / GPU / Edge 浏览器等），避免资源泄漏
      // 同步执行，调用方已经在 listInstances 上下文；不阻塞 UI
      const orphans = findOrphanPids(marker)
      let browserOrphans: number[] = []
      for (const browserMarker of browserMarkersForConfigMarker(marker)) {
        browserOrphans = [...browserOrphans, ...findOrphanPids(browserMarker)]
      }
      browserOrphans = [...browserOrphans, ...getInstanceBrowserPids(path.dirname(configDir))]
      for (const p of new Set([...orphans, ...browserOrphans])) {
        if (isProcessAlive(p)) {
          try {
            execSync(`taskkill /T /F /PID ${p}`, { stdio: 'ignore', timeout: 5000 })
          } catch {}
        }
      }
    }

    return {
      index: r.index,
      pid: mainPid || r.pid || 0,
      boxName: r.boxName,
      workDir: r.workDir,
      running,
      pids,
      fingerprint: r.fingerprint,
      createdAt: r.createdAt,
    }
  })
}

/** 更新实例记录中的 PID（运行时调用） */
export function updateInstancePid(profileId: string, index: number, pid: number): void {
  const records = loadInstanceRecords(profileId)
  const idx = records.findIndex((r) => r.index === index)
  if (idx >= 0) {
    records[idx].pid = pid
    records[idx].lastLaunchedAt = Date.now()
    writeFileSync(recordFile(profileId), JSON.stringify(records, null, 2), 'utf-8')
  }
}

// ==================== 引擎状态 ====================

export interface EngineStatus {
  ready: boolean
  version: string
}

export function getEngineStatus(): EngineStatus {
  return { ready: true, version: '1.0.0' }
}

// ==================== 代理可用性检测 ====================

/**
 * 测试单个代理是否可用（通过代理请求 httpbin.org/ip）
 * @param proxyUrl 代理 URL，如 http://1.2.3.4:8080
 * @param timeoutMs 超时毫秒（默认 4 秒）
 * @returns true=可用 false=不可用
 */
export function testProxyAlive(proxyUrl: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    // 解析代理 URL
    const m = proxyUrl.match(/^(?:https?:\/\/)?([^:\/]+):(\d+)/)
    if (!m) {
      resolve(false)
      return
    }
    const host = m[1]
    const port = Number(m[2])

    // 拒绝内网地址（SSRF 防护）
    const ipParts = host.match(/^(\d{1,3})\.(\d{1,3})/)
    if (ipParts) {
      const a = Number(ipParts[1])
      const b = Number(ipParts[2])
      if (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) {
        resolve(false)
        return
      }
    }

    // 使用 CONNECT 方法测试代理是否支持 HTTPS 隧道
    // 实际应用（Trae）使用 HTTPS，代理必须支持 CONNECT 方法
    // 注意：CONNECT 响应通过 'connect' 事件接收，不是回调函数
    const targets = [
      { h: 'httpbin.org', p: 443 },
      { h: 'www.google.com', p: 443 },
      { h: 'www.bing.com', p: 443 },
    ]
    let idx = 0
    let settled = false
    const tryNext = (): void => {
      if (idx >= targets.length || settled) { if (!settled) resolve(false); return }
      const t = targets[idx++]
      const req = http.request({
        host,
        port,
        method: 'CONNECT',
        path: `${t.h}:${t.p}`,
        timeout: timeoutMs,
      })
      req.on('connect', (res, socket) => {
        const alive = res.statusCode === 200
        socket.destroy()
        if (alive && !settled) { settled = true; resolve(true) }
        else tryNext()
      })
      req.on('timeout', () => { req.destroy(); tryNext() })
      req.on('error', () => tryNext())
      req.end()
    }
    tryNext()
  })
}

/**
 * 增强代理验证：通过代理请求外部服务，验证出网 IP 是否确实为代理 IP
 * 与 testProxyAlive 的区别：不仅验证代理是否可连接，还验证流量是否真实通过代理
 * @param proxyUrl 代理 URL
 * @param timeoutMs 超时毫秒
 * @returns { alive: boolean, externalIp?: string, latencyMs?: number }
 */
export async function validateProxyEgress(proxyUrl: string, timeoutMs = 5000): Promise<{ alive: boolean; externalIp?: string; latencyMs?: number }> {
  const startTime = Date.now()
  const m = proxyUrl.match(/^(?:https?:\/\/)?([^:\/]+):(\d+)/)
  if (!m) return { alive: false }
  const proxyHost = m[1]
  const proxyPort = Number(m[2])

  // 内网地址拒绝
  const ipParts = proxyHost.match(/^(\d{1,3})\.(\d{1,3})/)
  if (ipParts) {
    const a = Number(ipParts[1]); const b = Number(ipParts[2])
    if (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) {
      return { alive: false }
    }
  }

  return new Promise((resolve) => {
    // 通过代理向 httpbin.org/ip 发送 HTTP GET 请求，获取出网 IP
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: 'httpbin.org:443',
      timeout: timeoutMs,
    })
    const timer = setTimeout(() => { req.destroy(); resolve({ alive: false }) }, timeoutMs)

    req.on('connect', (res, socket) => {
      clearTimeout(timer)
      if (res.statusCode !== 200) {
        socket.destroy()
        resolve({ alive: false })
        return
      }
      // 代理隧道已建立，通过隧道发送 HTTPS 请求获取外部 IP
      const hReq = https.request({
        host: 'httpbin.org',
        path: '/ip',
        method: 'GET',
        socket,
        agent: false,
        timeout: timeoutMs,
        rejectUnauthorized: true,
      } as any, (hRes: any) => {
        let data = ''
        hRes.on('data', (chunk: string) => { data += chunk })
        hRes.on('end', () => {
          try {
            const json = JSON.parse(data)
            const externalIp = json.origin || ''
            const latencyMs = Date.now() - startTime
            resolve({ alive: true, externalIp, latencyMs })
          } catch {
            resolve({ alive: false })
          }
          socket.destroy()
        })
      })
      hReq.on('timeout', () => { hReq.destroy(); socket.destroy(); resolve({ alive: false }) })
      hReq.on('error', () => { socket.destroy(); resolve({ alive: false }) })
      hReq.end()
    })
    req.on('timeout', () => { clearTimeout(timer); resolve({ alive: false }) })
    req.on('error', () => { clearTimeout(timer); resolve({ alive: false }) })
    req.end()
  })
}

// ==================== 系统代理设置 ====================

/**
 * 设置 Windows 系统代理（WinINET，影响所有使用 WinINET/WinHTTP 的应用）
 * 使用 PowerShell 设置注册表，影响 IE/Edge/Chrome 等浏览器
 * @param proxyServer 代理地址，如 "1.2.3.4:8080"
 * @param bypass 直连列表（逗号分隔）
 * @returns 设置前的代理配置（用于恢复）
 */
export function setSystemProxy(proxyServer: string, bypass: string = '127.0.0.1;localhost;::1'): { previousServer: string; previousEnabled: number } | null {
  try {
    // 读取当前代理设置
    const prevServer = String(execSync(
      `powershell -NoProfile -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyServer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProxyServer"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    )).trim()
    const prevEnabled = Number(String(execSync(
      `powershell -NoProfile -Command "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProxyEnable"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    )).trim()) || 0

    // 设置新代理
    execSync(
      `powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyServer -Value '${proxyServer.replace(/'/g, "''")}'; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Value 1; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyOverride -Value '${bypass.replace(/'/g, "''")}'"`,
      { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' }
    )
    console.log(`[Engine] 已设置系统代理: ${proxyServer} (bypass=${bypass})`)
    return { previousServer: prevServer, previousEnabled: prevEnabled }
  } catch (e: any) {
    console.log(`[Engine] 设置系统代理失败: ${e?.message || e}`)
    return null
  }
}

/**
 * 恢复 Windows 系统代理设置
 * @param previous 之前保存的代理配置
 */
export function restoreSystemProxy(previous: { previousServer: string; previousEnabled: number } | null): void {
  if (!previous) return
  try {
    if (previous.previousEnabled) {
      execSync(
        `powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyServer -Value '${(previous.previousServer || '').replace(/'/g, "''")}'; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Value ${previous.previousEnabled}"`,
        { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' }
      )
    } else {
      execSync(
        `powershell -NoProfile -Command "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name ProxyEnable -Value 0"`,
        { encoding: 'utf-8', timeout: 5000, stdio: 'ignore' }
      )
    }
    console.log(`[Engine] 已恢复系统代理设置`)
  } catch (e: any) {
    console.log(`[Engine] 恢复系统代理失败: ${e?.message || e}`)
  }
}

// ==================== DNS 泄漏防护 ====================

/**
 * 生成 Chromium --host-resolver-rules 参数，强制 DNS 通过代理解析
 * 防止 DNS 泄漏（即使设置了代理，DNS 查询可能仍走本地 DNS 服务器）
 */
function buildDnsLeakRules(proxy?: string): string[] {
  if (!proxy) return []
  // MAP * ~NOTFOUND 将所有域名解析重定向到不存在的地址，
  // 强制 Chromium 通过代理进行 DNS 解析（SOCKS5 代理或 HTTP CONNECT）
  // 注意：这要求代理支持 DNS 解析（SOCKS5 代理自动支持，HTTP 代理通过 CONNECT 隧道）
  const rules: string[] = []
  // 对本地/OAuth 回调域名保持直连解析
  rules.push('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1 , EXCLUDE ::1')
  // 禁用内置 DNS 客户端（Chromium 的异步 DNS 可能绕过代理）
  rules.push('--disable-async-dns')
  // 禁用 DNS-over-HTTPS（DoH 会绕过代理直接向 DNS 服务器发 HTTPS 请求）
  rules.push('--disable-features=AsyncDns,UseDnsHttpsSvcb')
  return rules
}
