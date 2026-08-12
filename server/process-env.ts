// 读取其他进程的环境块（通过 PEB + ReadProcessMemory），用于识别
// “命令行里没有 user-data-dir 标记”的实例浏览器进程（WorkBuddy 自己启动的
// Edge 默认配置浏览器：主进程环境被精简，但子进程携带完整实例环境）。

import { execFileSync } from 'node:child_process'
import koffi from 'koffi'

const kernel32 = koffi.load('kernel32.dll')
const ntdll = koffi.load('ntdll.dll')

const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32_t', 'bool', 'uint32_t'])
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *'])
const ReadProcessMemory = kernel32.func('__stdcall', 'ReadProcessMemory', 'bool', ['void *', 'void *', 'void *', 'uintptr_t', 'uintptr_t *'])
const NtQueryInformationProcess = ntdll.func('__stdcall', 'NtQueryInformationProcess', 'int', ['void *', 'int', 'void *', 'uint32_t', 'void *'])

const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_VM_READ = 0x0010

function readProcessMemory(h: any, address: bigint, size: number): Buffer | null {
  const buf = Buffer.alloc(size)
  const done = Buffer.alloc(8)
  const ok = ReadProcessMemory(h, address, buf, size, done)
  return ok ? buf : null
}

/** 读取指定进程的环境块文本（UTF-16，最多 16KB）；失败返回 null */
function readProcessEnvironmentText(pid: number): string | null {
  const h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
  if (!h) return null
  try {
    const pbi = Buffer.alloc(48)
    const ret = Buffer.alloc(4)
    const st = NtQueryInformationProcess(h, 0, pbi, 48, ret)
    if (st !== 0) return null
    const peb = pbi.readBigUInt64LE(8)
    const pebBuf = readProcessMemory(h, peb, 0x100)
    if (!pebBuf) return null
    const pp = pebBuf.readBigUInt64LE(0x20)
    const ppBuf = readProcessMemory(h, pp, 0x100)
    if (!ppBuf) return null
    const env = ppBuf.readBigUInt64LE(0x80)
    // 环境块大小不固定，按 4KB 分块读取，遇双空终止即停（避免越界导致读取失败）
    let text = ''
    for (let offset = 0; offset < 32768; offset += 4096) {
      const chunk = readProcessMemory(h, env + BigInt(offset), 4096)
      if (!chunk) break
      const part = chunk.toString('utf16le')
      text += part
      if (part.includes('\u0000\u0000')) break
    }
    return text || null
  } finally {
    CloseHandle(h)
  }
}

/** 返回环境中 KEY 以 VALUE 前缀开头的进程 PID 列表（仅查浏览器进程，速度快） */
export function getPidsWithEnvValue(key: string, valuePrefix: string): number[] {
  if (!key || !valuePrefix) return []
  let pids: number[] = []
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('msedge.exe','chrome.exe') } | Select-Object -ExpandProperty ProcessId",
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    )
    pids = Array.from(new Set(out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => n > 0)))
  } catch {
    return []
  }

  const needle = `${key}=${valuePrefix}`
  const matched: number[] = []
  for (const pid of pids) {
    try {
      const text = readProcessEnvironmentText(pid)
      if (text && text.includes(needle)) matched.push(pid)
    } catch {
      // 单个进程读取失败不影响其他进程
    }
  }
  return matched
}

/** 从环境块文本中解析 EDGE_BROWSER_PID / CHROME_BROWSER_PID 之类的父浏览器 PID */
export function parseBrowserParentPids(pid: number): number[] {
  const text = readProcessEnvironmentText(pid)
  if (!text) return []
  const result: number[] = []
  const re = /(?:EDGE|CHROME)_BROWSER_PID=(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const v = Number(m[1])
    if (v > 0) result.push(v)
  }
  return result
}
