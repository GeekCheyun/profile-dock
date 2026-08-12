import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import test from 'node:test'
import { inspectAuthorizationRouting } from '../server/auth-routing.js'

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function waitForPort(port: number, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const probe = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started >= timeoutMs) reject(new Error(`listener ${port} did not start`))
        else setTimeout(probe, 100)
      })
    }
    probe()
  })
}

test('binds a loopback callback receipt to the owning instance process without storing secrets', { timeout: 20000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows process ownership integration')
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'multiopen-auth-owner-'))
  const workDir = path.join(tempRoot, 'instance-1')
  const configDir = path.join(workDir, 'config')
  const port = await reservePort()
  const helperCode = [
    "const http=require('node:http')",
    "const port=Number(process.env.MULTIOPEN_TEST_PORT)",
    "http.createServer((_req,res)=>res.end('ok')).listen(port,'127.0.0.1')",
    "setInterval(()=>{},1000)",
  ].join(';')
  const helper = spawn(process.execPath, [
    '-e', helperCode, '--', `--user-data-dir=${configDir}`,
  ], {
    env: { ...process.env, MULTIOPEN_TEST_PORT: String(port) },
    stdio: 'ignore',
    windowsHide: true,
  })

  try {
    await waitForPort(port)
    const secretSentinel = 'challenge-must-not-be-persisted'
    const url = new URL('https://example.test/authorization')
    url.searchParams.set('auth_callback_url', `http://127.0.0.1:${port}/authorize`)
    url.searchParams.set('code_challenge', secretSentinel)
    const { receipt } = inspectAuthorizationRouting(url.href, {
      box: 'Integration-1',
      workDir,
      appPath: process.execPath,
    })
    assert.equal(receipt.listenerPid, helper.pid)
    assert.equal(receipt.instanceMainPid, helper.pid)
    assert.equal(receipt.listenerOwnedByInstance, true)
    assert.deepEqual(receipt.authorizationQueryKeys, ['auth_callback_url', 'code_challenge'])

    const receiptPath = path.join(workDir, 'runtime', 'authorization-receipts.jsonl')
    assert.equal(existsSync(receiptPath), true)
    const persisted = readFileSync(receiptPath, 'utf8')
    assert.equal(persisted.includes(secretSentinel), false)
    assert.equal(persisted.includes(url.href), false)
  } finally {
    if (helper.pid) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(helper.pid), '/T', '/F'], { windowsHide: true })
      } catch {}
    }
    assert.ok(tempRoot.startsWith(os.tmpdir()))
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
