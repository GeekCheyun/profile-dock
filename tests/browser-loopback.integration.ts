import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { detectBrowserPath } from '../server/engine.js'

test('real Chromium reaches a loopback callback directly even with an unreachable proxy', { timeout: 30000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows Edge integration')
  const browserPath = detectBrowserPath('not-a-browser.exe')
  if (!browserPath) return t.skip('Chrome/Edge not installed')

  const profile = mkdtempSync(path.join(os.tmpdir(), 'multiopen-loopback-browser-'))
  let callbackSeen = false
  const server = http.createServer((_req, res) => {
    callbackSeen = true
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<!doctype html><title>loopback-ok</title><p>loopback-ok</p>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const child = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    '--proxy-server=http://127.0.0.1:9',
    '--dump-dom',
    `http://127.0.0.1:${port}/authorize?code=synthetic`,
  ], { stdio: 'ignore', windowsHide: true })

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser loopback timeout')), 12000)
      const poll = setInterval(() => {
        if (!callbackSeen) return
        clearTimeout(timer)
        clearInterval(poll)
        resolve()
      }, 50)
      child.once('error', (error) => {
        clearTimeout(timer)
        clearInterval(poll)
        reject(error)
      })
    })
    assert.equal(callbackSeen, true)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (child.exitCode === null && !child.killed) {
      await Promise.race([
        new Promise<void>((resolve) => child.once('close', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
      if (child.exitCode === null) child.kill()
    }
    assert.ok(profile.startsWith(os.tmpdir()))
    rmSync(profile, { recursive: true, force: true })
  }
})
