import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { run, q } from './util.js'
import type { EnvInfo } from './types.js'

// 项目内置 Sandboxie 目录（sandboxie/ 子目录）
import { ROOT } from './util.js'
const BUNDLED_DIR = path.join(ROOT, 'sandboxie')

// Sandboxie 候选安装目录（含 D 盘常见非默认路径）
const CANDIDATE_DIRS = [
  'C:\\Program Files\\Sandboxie-Plus',
  'C:\\Program Files\\Sandboxie',
  'C:\\Program Files (x86)\\Sandboxie-Plus',
  'C:\\Program Files (x86)\\Sandboxie',
  'D:\\ProgramFiles\\Sandboxie-Plus',
  'D:\\ProgramFiles\\Sandboxie',
  'D:\\Program Files\\Sandboxie-Plus',
  'D:\\Program Files\\Sandboxie',
  'D:\\Sandboxie-Plus',
  'D:\\Sandboxie',
]

export interface DetectResult {
  installed: boolean
  startExe: string
  sbieIniExe: string
  dir: string
  bundled: boolean // 是否使用项目内置的 Sandboxie
}

function tryDir(dir: string, bundled = false): DetectResult | null {
  if (!dir) return null
  const startExe = path.join(dir, 'Start.exe')
  if (existsSync(startExe)) {
    return { installed: true, startExe, sbieIniExe: path.join(dir, 'SbieIni.exe'), dir, bundled }
  }
  return null
}

// 通过 SbieSvc 服务的 ImagePath 定位真实安装目录
function readSbieSvcDir(): string {
  try {
    const out = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\SbieSvc" /v ImagePath', {
      windowsHide: true,
      timeout: 5000,
    }).toString()
    const m = out.match(/REG(?:_EXPAND)?_SZ\s+(.+)/)
    if (!m) return ''
    let p = m[1].trim().replace(/^"|"$/g, '')
    const ex = p.match(/.*?\.exe/i)
    if (!ex) return ''
    return path.dirname(ex[0].replace(/"/g, ''))
  } catch {
    return ''
  }
}

// 探测 Sandboxie 安装位置：项目内置目录 → 系统候选目录 → SbieSvc 服务路径
// 不再支持手动指定目录 —— 作为独立商用应用，Sandboxie 由本项目自行管理。
export function detectSandboxie(): DetectResult {
  // Prefer the directory registered with SbieSvc. A bundled copy can be
  // present while a complete system installation is available elsewhere.
  const svcDir = readSbieSvcDir()
  if (svcDir) {
    const r = tryDir(svcDir)
    if (r) return r
  }
  // Then use a complete system installation if one exists.
  for (const d of CANDIDATE_DIRS) {
    const r = tryDir(d)
    if (r) return r
  }
  // Finally use the project-bundled copy.
  const bundled = tryDir(BUNDLED_DIR, true)
  if (bundled) return bundled
  return { installed: false, startExe: '', sbieIniExe: '', dir: '', bundled: false }
}

/** 检查项目内置 sandboxie/ 目录是否存在 */
export function isBundledAvailable(): boolean {
  return existsSync(path.join(BUNDLED_DIR, 'Start.exe'))
}

/** 获取内置目录路径 */
export function getBundledDir(): string {
  return BUNDLED_DIR
}

// 规整为 OpenFilePath 形态：反斜杠 + 结尾反斜杠
export function normalizeOpenPath(p: string): string {
  let v = (p || '').trim().replace(/\//g, '\\')
  if (!v) return ''
  if (!v.endsWith('\\')) v += '\\'
  return v
}

// 沙箱名总长上限 32 字符，截断前缀
export function buildBoxName(prefix: string, index: number): string {
  const p = (prefix || 'App').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'App'
  const suffix = `_${index}`
  const max = 32 - suffix.length
  return p.slice(0, max) + suffix
}

export interface EnsureBoxOptions {
  openPaths: string[]
  cleanOnClose: boolean
  boxNameTitle: boolean
  extraIni: string // 已包含指纹 ini 行
}

export class Sandboxie {
  constructor(public startExe: string, public sbieIniExe: string) {}

  private activeConfigFile(): string {
    const systemFile = path.join(process.env.SystemRoot || 'C:\\Windows', 'Sandboxie.ini')
    return existsSync(systemFile) ? systemFile : path.join(path.dirname(this.sbieIniExe), 'Sandboxie.ini')
  }

  /** Portable mode may not create Sandboxie.ini through SbieIni alone. */
  private seedBoxConfig(box: string, opts: EnsureBoxOptions): void {
    const file = this.activeConfigFile()
    let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const escaped = box.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const section = new RegExp(`(^|\\r?\\n)\\[${escaped}\\]([\\s\\S]*?)(?=\\r?\\n\\[|$)`, 'i')
    const lines = [
      'Enabled=y',
      `AutoDelete=${opts.cleanOnClose ? 'y' : 'n'}`,
      `BoxNameTitle=${opts.boxNameTitle ? '-' : ''}`,
      ...opts.openPaths.map(normalizeOpenPath).filter(Boolean).map((p) => `OpenFilePath=${p}`),
    ]
    const block = `[${box}]\r\n${lines.join('\r\n')}\r\n`
    if (section.test(text)) text = text.replace(section, `\r\n${block}`)
    else text = `${text.replace(/\s+$/g, '')}${text.trim() ? '\r\n\r\n' : ''}${block}`
    writeFileSync(file, text, 'utf8')
  }

  async version(): Promise<string> {
    const safe = this.startExe.replace(/'/g, "''")
    const r = await run(
      `powershell -NoProfile -Command "(Get-Item '${safe}').VersionInfo.ProductVersion"`,
      { timeout: 8000 }
    )
    return r.ok ? r.stdout.trim() : ''
  }

  async serviceRunning(): Promise<boolean> {
    const r = await run('sc query SbieSvc', { timeout: 6000 })
    return /RUNNING/i.test(r.stdout)
  }

  async env(isAdmin: boolean, bundled = false): Promise<EnvInfo> {
    return {
      installed: true,
      startExe: this.startExe,
      sbieIniExe: this.sbieIniExe,
      dir: path.dirname(this.startExe),
      isAdmin,
      version: await this.version(),
      serviceRunning: await this.serviceRunning(),
      bundled,
    }
  }

  async listBoxes(): Promise<string[]> {
    const r = await run(`${q(this.sbieIniExe)} query *`, { timeout: 10000 })
    const fromTool = r.ok ? r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('[') && !l.includes('=') && l.toLowerCase() !== 'globalsettings' && !l.toLowerCase().startsWith('usersettings_')) : []
    if (fromTool.length > 0) return fromTool
    const file = this.activeConfigFile()
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.match(/^\[([^\]]+)\]$/)?.[1] || '')
      .filter((name) => name && name.toLowerCase() !== 'globalsettings' && !name.toLowerCase().startsWith('usersettings_'))
  }

  // 创建/更新一个沙箱配置：Enabled + OpenFilePath + 指纹 + 可选项，随后 reload
  async ensureBox(box: string, opts: EnsureBoxOptions): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
    const steps: string[] = []
    steps.push(`${q(this.sbieIniExe)} set ${q(box)} Enabled y`)
    steps.push(
      opts.boxNameTitle
        ? `${q(this.sbieIniExe)} set ${q(box)} BoxNameTitle -`
        : `${q(this.sbieIniExe)} set ${q(box)} BoxNameTitle ""`
    )
    steps.push(`${q(this.sbieIniExe)} set ${q(box)} AutoDelete ${opts.cleanOnClose ? 'y' : 'n'}`)
    steps.push(`${q(this.sbieIniExe)} set ${q(box)} OpenFilePath ""`)
    for (const raw of opts.openPaths) {
      const p = normalizeOpenPath(raw)
      if (p) steps.push(`${q(this.sbieIniExe)} append ${q(box)} OpenFilePath ${q(p)}`)
    }
    // extraIni 已包含指纹配置行（SetEnvironmentVar / ProxyServer 等）
    for (const line of opts.extraIni.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith(';') || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const key = t.slice(0, eq).trim()
      const val = t.slice(eq + 1).trim()
      steps.push(`${q(this.sbieIniExe)} set ${q(box)} ${q(key)} ${q(val)}`)
    }

    this.seedBoxConfig(box, opts)
    const failures: string[] = []
    for (const cmd of steps) {
      const r = await run(cmd, { timeout: 12000 })
      if (!r.ok) failures.push(`${cmd.slice(cmd.indexOf(' ') + 1)}: ${r.stderr || `code=${r.code}`}`)
    }
    await this.reload()

    const boxes = await this.listBoxes()
    if (!boxes.includes(box)) {
      return { ok: false, stdout: '', stderr: failures[0] || `Sandboxie 配置未找到实例沙箱 ${box}`, code: -1 }
    }
    return { ok: true, stdout: '', stderr: '', code: 0 }
  }

  async removeBox(box: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
    // Sandboxie 删除整个沙箱配置节的正确语法：set <box> * DELETE
    // 注意：旧实现用 set <box> * "" 只是清空键值，沙箱节仍存在，会导致删除失败
    const r = await run(`${q(this.sbieIniExe)} set ${q(box)} * DELETE`, { timeout: 12000 })
    // reload 失败不影响删除结果，独立执行
    await this.reload().catch(() => {})
    return r
  }

  async reload(): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
    return run(`${q(this.startExe)} /reload`, { timeout: 12000 })
  }

  async launch(box: string, appPath: string, args: string, workDir: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
    const cwd = workDir || path.dirname(appPath)
    const argStr = (args || '').trim()
    // 安全防护：移除 shell 元字符防止命令注入（appArgs 是用户输入）
    // 保留常见的启动参数字符（字母数字、空格、-、/、=、.、:、_、%）
    const safeArgs = argStr ? ' ' + argStr.replace(/[&|<>^()`"!]/g, '') : ''
    const cmd = `${q(this.startExe)} /silent /box:${box} ${q(appPath)}${safeArgs}`
    return run(cmd, { cwd, timeout: 20000 })
  }

  async listPids(box: string): Promise<{ count: number; pids: number[] }> {
    const r = await run(`${q(this.startExe)} /silent /box:${box} /listpids`, { timeout: 10000 })
    const nums = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d+$/.test(l))
      .map(Number)
    if (nums.length === 0) return { count: 0, pids: [] }
    const count = nums[0]
    const pids = nums.slice(1)
    return { count: pids.length || count, pids }
  }

  async terminate(box: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
    // 第一步：Sandboxie 原生终止（温和退出，让进程自行清理）
    const r1 = await run(`${q(this.startExe)} /silent /box:${box} /terminate`, { timeout: 15000 })

    // 第二步：短暂等待后检查残留进程，用 taskkill /F 强杀，确保立即释放内存
    await new Promise((resolve) => setTimeout(resolve, 800))
    const { pids } = await this.listPids(box)
    if (pids.length > 0) {
      // 强制终止所有残留进程（/F 强制结束 /T 连带子进程）
      const pidList = pids.join(' ')
      await run(`taskkill /F /T /PID ${pidList}`, { timeout: 10000 }).catch(() => {})
      // 再次等待确保进程完全退出
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    return r1
  }

  async deleteContent(box: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
    return run(`${q(this.startExe)} /silent /box:${box} delete_sandbox_silent`, { timeout: 60000 })
  }
}
