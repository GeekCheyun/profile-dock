import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { launchUrlInInstanceBrowser } from '../server/instance-browser.js'

test('browser rejects non-http protocols before resolving an executable', () => {
  assert.throws(
    () => launchUrlInInstanceBrowser('file:///C:/Windows/win.ini', { appPath: '', workDir: path.join(process.cwd(), 'engine', 'instances', 'p1', '1') }),
    /只允许打开 http\/https/,
  )
})

test('browser rejects URLs over the maximum length', () => {
  assert.throws(
    () => launchUrlInInstanceBrowser(`https://example.test/${'x'.repeat(16 * 1024)}`, { appPath: '', workDir: path.join(process.cwd(), 'engine', 'instances', 'p1', '1') }),
    /URL 为空或过长/,
  )
})

test('browser rejects an empty URL before resolving an executable', () => {
  assert.throws(
    () => launchUrlInInstanceBrowser('', { appPath: '', workDir: path.join(process.cwd(), 'engine', 'instances', 'p1', '1') }),
    /URL 为空或过长/,
  )
})

test('browser rejects whitespace-only URLs before parsing', () => {
  assert.throws(
    () => launchUrlInInstanceBrowser(' \t\r\n ', { appPath: '', workDir: path.join(process.cwd(), 'engine', 'instances', 'p1', '1') }),
    /URL 为空或过长/,
  )
})

test('实例浏览器拒绝非受管工作目录，避免回退到宿主 Profile', () => {
  assert.throws(
    () => launchUrlInInstanceBrowser('https://example.test/', { appPath: 'C:\\Program Files\\Chrome\\chrome.exe', workDir: path.resolve('outside-instance') }),
    /不属于受管实例目录/,
  )
})

test('实例浏览器拒绝带账号密码的 URL', () => {
  assert.throws(
    () => launchUrlInInstanceBrowser('https://user:pass@example.test/', { appPath: '', workDir: path.join(process.cwd(), 'engine', 'instances', 'p1', '1') }),
    /不允许携带账号或密码/,
  )
})
