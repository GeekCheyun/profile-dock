import crypto from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { detectBrowserPath, findMainPid, isProcessAlive } from './engine.js'
import { attachProcessToJob } from './job-object.js'

const MAX_AUTH_URL_LENGTH = 16 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1'

export interface AuthorizationTarget {
  authorizationHost: string
  authorizationPath: string
  authorizationQueryKeys: string[]
  callbackHost: string
  callbackPort: number
  callbackPath: string
}

export interface AuthorizationReceipt extends AuthorizationTarget {
  version: 1
  receiptId: string
  timestamp: string
  box: string
  status: 'inspected' | 'blocked' | 'launch-dispatched' | 'launch-failed'
  reason?: string
  listenerPid: number
  instanceMainPid: number
  listenerOwnedByInstance: boolean
  browserExecutable: string
  browserProfile: string
  hasProxy: boolean
  browserPid?: number
}

export interface AuthorizationRoutingContext {
  box: string
  workDir: string
  appPath: string
  proxy?: string
  instanceMainPid?: number
}

function normalizeLoopbackHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/**
 * Parse a native-app authorization URL without retaining secrets. Only the
 * host/path, query-key names and loopback callback coordinates are returned.
 */
export function parseAuthorizationTarget(rawUrl: string): AuthorizationTarget {
  if (!rawUrl || rawUrl.length > MAX_AUTH_URL_LENGTH) {
    throw new Error('授权链接为空或过长')
  }

  let authorizationUrl: URL
  try {
    authorizationUrl = new URL(rawUrl)
  } catch {
    throw new Error('授权链接格式无效')
  }
  if (authorizationUrl.protocol !== 'https:') {
    throw new Error('授权入口必须使用 HTTPS')
  }
  if (authorizationUrl.username || authorizationUrl.password) {
    throw new Error('授权链接不得包含 URL 凭据')
  }

  const callbackValue = authorizationUrl.searchParams.get('auth_callback_url')
    || authorizationUrl.searchParams.get('redirect_uri')
  if (!callbackValue) {
    throw new Error('授权链接缺少 auth_callback_url/redirect_uri')
  }

  let callbackUrl: URL
  try {
    callbackUrl = new URL(callbackValue)
  } catch {
    throw new Error('授权回调地址格式无效')
  }
  const callbackHost = normalizeLoopbackHost(callbackUrl.hostname)
  if (callbackUrl.protocol !== 'http:' || !LOOPBACK_HOSTS.has(callbackHost)) {
    throw new Error('只允许 HTTP loopback 回调（127.0.0.1/localhost/::1）')
  }
  if (callbackUrl.username || callbackUrl.password || callbackUrl.hash) {
    throw new Error('授权回调地址包含不允许的凭据或片段')
  }
  const callbackPort = Number(callbackUrl.port)
  if (!Number.isInteger(callbackPort) || callbackPort < 1024 || callbackPort > 65535) {
    throw new Error('授权回调必须使用有效的临时端口')
  }

  return {
    authorizationHost: authorizationUrl.hostname.toLowerCase(),
    authorizationPath: authorizationUrl.pathname,
    authorizationQueryKeys: Array.from(new Set(authorizationUrl.searchParams.keys())).sort(),
    callbackHost,
    callbackPort,
    callbackPath: callbackUrl.pathname,
  }
}

function findLoopbackListenerPid(port: number): number {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    })
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/)
      if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue
      if (columns[3].toUpperCase() !== 'LISTENING') continue
      const local = columns[1]
      const match = local.match(/^(.+):(\d+)$/)
      if (!match || Number(match[2]) !== port) continue
      const host = normalizeLoopbackHost(match[1])
      if (LOOPBACK_HOSTS.has(host) || host === '0.0.0.0' || host === '::') {
        return Number(columns[4]) || 0
      }
    }
  } catch {}
  return 0
}

function processAncestors(processId: number): number[] {
  if (!Number.isInteger(processId) || processId <= 0) return []
  const script = [
    `$targetProcessId=${processId}`,
    '$items=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue',
    '$parents=@{}',
    'foreach($item in $items){$parents[[int]$item.ProcessId]=[int]$item.ParentProcessId}',
    '$result=@()',
    '$current=$targetProcessId',
    'for($i=0;$i -lt 32;$i++){if(-not $parents.ContainsKey($current)){break};$current=$parents[$current];if($current -le 0){break};$result+=$current}',
    '$result -join ","',
  ].join(';')
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    })
    return output.trim().split(',').map(Number).filter((pid) => pid > 0)
  } catch {
    return []
  }
}

function receiptFile(workDir: string): string {
  return path.join(workDir, 'runtime', 'authorization-receipts.jsonl')
}

function persistReceipt(workDir: string, receipt: AuthorizationReceipt): void {
  const file = receiptFile(workDir)
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(receipt) + '\n', 'utf8')
}

export function readAuthorizationReceipts(workDir: string, limit = 20): AuthorizationReceipt[] {
  const file = receiptFile(workDir)
  if (!existsSync(file)) return []
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(100, limit)))
      .map((line) => JSON.parse(line) as AuthorizationReceipt)
  } catch {
    return []
  }
}

export function inspectAuthorizationRouting(
  rawUrl: string,
  context: AuthorizationRoutingContext,
): { target: AuthorizationTarget; receipt: AuthorizationReceipt } {
  const target = parseAuthorizationTarget(rawUrl)
  const configDir = path.join(context.workDir, 'config')
  const marker = `--user-data-dir=${configDir}`
  const recordedMainPid = Number(context.instanceMainPid) || 0
  const instanceMainPid = isProcessAlive(recordedMainPid) ? recordedMainPid : findMainPid(marker)
  const listenerPid = findLoopbackListenerPid(target.callbackPort)
  // Most blocked/stale URLs have no listener; avoid multiple whole-system CIM
  // scans on that fast-fail path. When a listener exists, one ancestry query is
  // enough to prove it descends from the recorded instance main process.
  const ancestors = listenerPid > 0 ? processAncestors(listenerPid) : []
  const listenerOwnedByInstance = listenerPid > 0 && (
    listenerPid === instanceMainPid
    || (instanceMainPid > 0 && ancestors.includes(instanceMainPid))
  )
  const browserExecutable = detectBrowserPath(context.appPath)
  const browserProfile = path.join(context.workDir, 'browser-profile-v2')

  const receipt: AuthorizationReceipt = {
    version: 1,
    receiptId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    box: context.box,
    status: 'inspected',
    listenerPid,
    instanceMainPid,
    listenerOwnedByInstance,
    browserExecutable,
    browserProfile,
    hasProxy: !!context.proxy,
    ...target,
  }
  persistReceipt(context.workDir, receipt)
  return { target, receipt }
}

export function buildAuthorizationBrowserArgs(
  rawUrl: string,
  browserProfile: string,
  proxy?: string,
): string[] {
  // Parse first so callers cannot use this broker as a generic process/URL
  // launcher and so malformed nested callback URLs fail closed.
  parseAuthorizationTarget(rawUrl)
  const args = [
    `--user-data-dir=${browserProfile}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-quic',
  ]
  if (proxy) args.push(`--proxy-server=${proxy}`)
  // Deliberately no subtractive loopback bypass flag. Chromium's implicit
  // bypass keeps native-app callbacks on this machine.
  args.push(rawUrl)
  return args
}

export function launchAuthorizationInInstance(
  rawUrl: string,
  context: AuthorizationRoutingContext,
): AuthorizationReceipt {
  const { receipt } = inspectAuthorizationRouting(rawUrl, context)
  const fail = (reason: string): AuthorizationReceipt => {
    const blocked: AuthorizationReceipt = {
      ...receipt,
      receiptId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      status: 'blocked',
      reason,
    }
    persistReceipt(context.workDir, blocked)
    return blocked
  }

  if (!receipt.instanceMainPid) return fail('目标实例未运行')
  if (!receipt.listenerPid) return fail(`回调端口 ${receipt.callbackPort} 尚未监听，授权链接可能已过期`)
  if (!receipt.listenerOwnedByInstance) return fail('回调监听进程不属于目标实例，已阻止错投授权码')
  if (!receipt.browserExecutable || !existsSync(receipt.browserExecutable)) return fail('未找到可用的 Chrome/Edge 浏览器')

  mkdirSync(receipt.browserProfile, { recursive: true })
  const args = buildAuthorizationBrowserArgs(rawUrl, receipt.browserProfile, context.proxy)

  try {
    const child = spawn(receipt.browserExecutable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: {
        ...process.env,
        NO_PROXY: LOOPBACK_NO_PROXY,
        no_proxy: LOOPBACK_NO_PROXY,
      },
    })
    // 防止浏览器路径在预检后失效时产生未处理的 ChildProcess error，
    // 该错误不能传播为 Electron 主进程异常。
    child.once('error', (error) => {
      const failed: AuthorizationReceipt = {
        ...receipt,
        receiptId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        status: 'launch-failed',
        reason: error?.message || '浏览器进程启动失败',
      }
      persistReceipt(context.workDir, failed)
    })
    child.unref()
    attachProcessToJob(path.join(context.workDir, 'config'), child.pid || 0)
    const launched: AuthorizationReceipt = {
      ...receipt,
      receiptId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      status: 'launch-dispatched',
      browserPid: child.pid,
    }
    persistReceipt(context.workDir, launched)
    return launched
  } catch (error: any) {
    const failed: AuthorizationReceipt = {
      ...receipt,
      receiptId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      status: 'launch-failed',
      reason: error?.message || String(error),
    }
    persistReceipt(context.workDir, failed)
    return failed
  }
}
