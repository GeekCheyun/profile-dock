import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { launchUrlInInstanceBrowser } from '../server/instance-browser.js'

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
