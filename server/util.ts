import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const pexec = promisify(exec)

export interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

export interface RunOptions {
  cwd?: string
  timeout?: number
}

// 以 shell 方式执行命令（Windows 默认 cmd.exe），便于捕获 GUI 程序(Start.exe)的 stdout
export async function run(cmd: string, opts: RunOptions = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await pexec(cmd, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 30000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString(), code: 0 }
  } catch (e: any) {
    return {
      ok: false,
      stdout: e?.stdout?.toString?.() ?? '',
      stderr: e?.stderr?.toString?.() ?? e?.message ?? String(e),
      code: e?.code ?? -1,
    }
  }
}

// 给路径/含空格的值加双引号
export function q(s: string): string {
  return `"${String(s ?? '').replace(/"/g, '')}"`
}

// 当前是否以管理员权限运行。
// 用 WindowsPrincipal.IsInRole 判定，不依赖 LanmanServer 服务（net session 在该服务停用时误报）。
export async function isAdmin(): Promise<boolean> {
  const r = await run(
    `powershell -NoProfile -Command "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)"`,
    { timeout: 8000 }
  )
  return r.ok && /^true$/i.test(r.stdout.trim())
}

// 用默认浏览器打开地址
export async function openBrowser(url: string): Promise<void> {
  await run(`cmd /c start "" ${q(url)}`, { timeout: 5000 }).catch(() => {})
}

export function uid(): string {
  return crypto.randomUUID()
}

// 项目根目录（server/ 的上一级）
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 桌面应用模式下由 Electron 指向 userData，避免打包后写入 Program Files
export const DATA_DIR = process.env.MULTIOPEN_DATA_DIR
  ? path.resolve(process.env.MULTIOPEN_DATA_DIR)
  : path.join(ROOT, 'data')
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const json = JSON.stringify(value, null, 2)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  const backup = `${file}.bak`
  writeFileSync(temp, json, 'utf8')
  if (existsSync(file)) {
    try {
      JSON.parse(readFileSync(file, 'utf8'))
      copyFileSync(file, backup)
    } catch {
      // Keep the last known-good backup when the primary is already corrupt.
    }
  }
  try {
    renameSync(temp, file)
  } catch {
    // Some Windows filesystems/AV products reject replace-on-rename. Keep the
    // verified backup and fall back to a direct write instead of losing state.
    writeFileSync(file, json, 'utf8')
    rmSync(temp, { force: true })
  }
}

export function readJsonWithBackup<T>(file: string): { value: T; recoveredFromBackup: boolean } | null {
  if (existsSync(file)) {
    try {
      return { value: JSON.parse(readFileSync(file, 'utf8')) as T, recoveredFromBackup: false }
    } catch {}
  }
  const backup = `${file}.bak`
  if (existsSync(backup)) {
    try {
      return { value: JSON.parse(readFileSync(backup, 'utf8')) as T, recoveredFromBackup: true }
    } catch {}
  }
  return null
}
