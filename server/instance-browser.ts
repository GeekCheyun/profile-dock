import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { detectBrowserPath } from './engine.js'
import { ROOT } from './util.js'
import { isWithinRoot } from './instance-layout.js'
import { attachProcessToJob } from './job-object.js'

const MAX_URL_LENGTH = 16 * 1024

export interface InstanceBrowserContext {
  appPath: string
  workDir: string
}

/** Launch a URL in the browser profile owned by one instance. */
export function launchUrlInInstanceBrowser(rawUrl: string, context: InstanceBrowserContext) {
  if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) throw new Error('URL 为空或过长')
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许打开 http/https 链接')
  if (url.username || url.password) throw new Error('URL 不允许携带账号或密码')
  const instancesRoot = path.join(ROOT, 'engine', 'instances')
  const workDir = path.resolve(context.workDir)
  if (!isWithinRoot(instancesRoot, workDir)) throw new Error('浏览器 Profile 不属于受管实例目录')

  const browserExecutable = detectBrowserPath(context.appPath)
  if (!browserExecutable || !existsSync(browserExecutable)) throw new Error('未找到 Chrome/Edge 浏览器')
  const browserProfile = path.join(workDir, 'browser-profile-v2')
  mkdirSync(browserProfile, { recursive: true })
  const child = spawn(browserExecutable, [
    `--user-data-dir=${browserProfile}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    url.toString(),
  ], { detached: true, stdio: 'ignore', windowsHide: false })
  // Node 会在 spawn 失败时异步发出 error；没有监听器会升级为 Electron
  // 主进程的 uncaught exception。路径已预检，但安装被移动/卸载或权限变化时
  // 仍必须安全失败，不能让管理器崩溃。
  child.once('error', () => {})
  child.unref()
  attachProcessToJob(path.join(workDir, 'config'), child.pid || 0)
  return { browserExecutable, browserProfile, browserPid: child.pid || 0 }
}
