import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  getEngineStatus,
  isProcessAlive,
  isProcessRunning,
  testProxyAlive,
  detectBrowserPath,
  resolveApplicationExecutable,
  terminateInstance,
} from '../server/engine.js'

// ==================== 引擎状态 ====================

test('getEngineStatus 返回 ready 状态', () => {
  const status = getEngineStatus()
  assert.equal(status.ready, true)
  assert.equal(status.version, '1.0.0')
})

// ==================== 进程存活检测 ====================

test('isProcessAlive 对无效 PID 返回 false', () => {
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(NaN), false)
})

test('isProcessAlive 对不存在的 PID 返回 false', async () => {
  // 使用一个极大 PID，极不可能存在
  assert.equal(isProcessAlive(99999999), false)
})

test('isProcessRunning 对无效 PID 且无 configDir 返回 false', () => {
  assert.equal(isProcessRunning(0), false)
  assert.equal(isProcessRunning(-1), false)
})

// ==================== 宿主保护 ====================

test('terminateInstance 拒绝终止实例管理范围外的目录（宿主保护）', async () => {
  // 传入一个不存在的大 PID + 宿主 WorkBuddy 配置目录：必须被拒绝，
  // 绝不能对宿主目录执行任何进程终止/清理动作。
  const hostDir = process.env.APPDATA || 'C:\\Users\\Public\\AppData'
  const r = await terminateInstance(99999999, hostDir)
  assert.equal(r.ok, false)
  assert.match(r.error || '', /实例管理范围/)
})

test('terminateInstance 拒绝实例管理范围外的相对路径穿越', async () => {
  const r = await terminateInstance(99999999, 'C:\\Users\\Public\\..\\Windows')
  assert.equal(r.ok, false)
  assert.match(r.error || '', /实例管理范围/)
})

// ==================== 代理验证 ====================

test('testProxyAlive 拒绝无效格式的代理 URL', async () => {
  assert.equal(await testProxyAlive(''), false)
  assert.equal(await testProxyAlive('not-a-proxy'), false)
  assert.equal(await testProxyAlive('http://'), false)
})

test('testProxyAlive 拒绝内网地址（SSRF 防护）', async () => {
  // 127.0.0.1
  assert.equal(await testProxyAlive('127.0.0.1:8080'), false)
  assert.equal(await testProxyAlive('http://127.0.0.1:8080'), false)

  // 10.x.x.x
  assert.equal(await testProxyAlive('10.0.0.1:8080'), false)

  // 192.168.x.x
  assert.equal(await testProxyAlive('192.168.1.1:8080'), false)

  // 172.16-31.x.x
  assert.equal(await testProxyAlive('172.16.0.1:8080'), false)
  assert.equal(await testProxyAlive('172.31.255.255:8080'), false)

  // 169.254.x.x (link-local)
  assert.equal(await testProxyAlive('169.254.1.1:8080'), false)
})

test('testProxyAlive 不拒绝公网地址格式', async () => {
  // 只验证格式不会立即拒绝，实际连接可能超时但不应该被 SSRF 过滤
  // 公网地址不应该被格式检查拒绝
  const result = await testProxyAlive('8.8.8.8:8080', 1000)
  // 可能返回 false（连接超时），但不应被 SSRF 过滤
  // 只要不抛异常即可
  assert.equal(typeof result, 'boolean')
})

// ==================== 浏览器路径检测 ====================

test('detectBrowserPath 对浏览器应用返回自身路径', () => {
  // Chrome/Edge/Firefox 路径应该直接返回
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  assert.equal(detectBrowserPath(chromePath), chromePath)

  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  assert.equal(detectBrowserPath(edgePath), edgePath)

  const firefoxPath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
  assert.equal(detectBrowserPath(firefoxPath), firefoxPath)
})

test('detectBrowserPath 对非浏览器应用返回系统浏览器路径', () => {
  // 非浏览器应用（如 Trae/VSCode），应该返回 Chrome 或 Edge 路径
  const idePath = 'C:\\Users\\test\\AppData\\Local\\Programs\\Trae\\Trae.exe'
  const result = detectBrowserPath(idePath)

  // 应该返回 Chrome 或 Edge 的路径，或空字符串（系统未安装）
  if (result) {
    assert.ok(
      result.toLowerCase().includes('chrome.exe') || result.toLowerCase().includes('msedge.exe'),
      `期望浏览器路径，得到: ${result}`
    )
  }
  // 如果返回空字符串，说明系统未安装 Chrome/Edge，这也是有效结果
})

test('detectBrowserPath 对空路径返回系统浏览器路径或空', () => {
  const result = detectBrowserPath('')
  // 如果安装了 Chrome/Edge，返回浏览器路径；否则返回空字符串
  if (result) {
    assert.ok(
      result.toLowerCase().includes('chrome.exe') || result.toLowerCase().includes('msedge.exe'),
      `期望浏览器路径，得到: ${result}`
    )
  }
})

test('detectBrowserPath 覆盖当前用户 AppData 下的 Chrome 安装', () => {
  const localChrome = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : ''
  const result = detectBrowserPath('C:\\Users\\test\\AppData\\Local\\Programs\\Trae\\Trae.exe')
  if (localChrome && existsSync(localChrome)) assert.equal(result, localChrome)
})

test('resolveApplicationExecutable 将 Chrome Application 文件夹解析为 chrome.exe', () => {
  const chromeDir = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application')
    : ''
  const chromeExe = chromeDir ? path.join(chromeDir, 'chrome.exe') : ''
  if (chromeDir && existsSync(chromeExe)) assert.equal(resolveApplicationExecutable(chromeDir), chromeExe)
})
