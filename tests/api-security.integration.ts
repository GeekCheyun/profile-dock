import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

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

function requestWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/health', headers: { Host: host } }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode || 0))
    })
    request.once('error', reject)
    request.end()
  })
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('local API did not become healthy')
}

test('production control API is loopback-bound, origin-checked and does not reveal its token', { timeout: 20000 }, async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-api-security-'))
  const port = await reservePort()
  const token = 'a'.repeat(64)
  writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port, profiles: [], instances: [] }), 'utf8')
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MULTIOPEN_DATA_DIR: dataDir,
      MULTIOPEN_API_TOKEN: token,
      ELECTRON_DESKTOP: '1',
      NODE_ENV: 'production',
    },
    stdio: 'ignore',
    windowsHide: true,
  })

  try {
    await waitForHealth(port)
    const tokenResponse = await fetch(`http://127.0.0.1:${port}/api/token`)
    assert.equal(tokenResponse.status, 401)
    const authenticatedTokenResponse = await fetch(`http://127.0.0.1:${port}/api/token`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(authenticatedTokenResponse.status, 404)

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/profiles`)
    assert.equal(unauthenticated.status, 401)

    const bareToken = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
      headers: { Authorization: token },
    })
    assert.equal(bareToken.status, 401)

    const untrustedOrigin = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'https://attacker.invalid' },
    })
    assert.equal(untrustedOrigin.status, 403)

    assert.equal(await requestWithHost(port, `attacker.invalid:${port}`), 421)

    const authorized = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(authorized.status, 200)
    assert.equal(authorized.headers.get('cache-control'), 'no-store')

    const missingProfileLaunch = await fetch(`http://127.0.0.1:${port}/api/profiles/missing/launch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(missingProfileLaunch.status, 404)

    const missingProfileInstances = await fetch(`http://127.0.0.1:${port}/api/profiles/missing/instances`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(missingProfileInstances.status, 404)

    const missingInstanceDiagnostics = await fetch(`http://127.0.0.1:${port}/api/instances/missing/diagnostics`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(missingInstanceDiagnostics.status, 404)

    const missingInstanceReceipts = await fetch(`http://127.0.0.1:${port}/api/instances/missing/authorization-receipts`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(missingInstanceReceipts.status, 404)

    const missingInstanceBrowser = await fetch(`http://127.0.0.1:${port}/api/instances/missing/browser`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(missingInstanceBrowser.status, 404)

    const missingInstanceAuthorization = await fetch(`http://127.0.0.1:${port}/api/instances/missing/authorization`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(missingInstanceAuthorization.status, 404)

    const disabledProxyFetch = await fetch(`http://127.0.0.1:${port}/api/proxy-pool/fetch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(disabledProxyFetch.status, 410)

    const disabledProxyAllocate = await fetch(`http://127.0.0.1:${port}/api/proxy-pool/allocate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(disabledProxyAllocate.status, 410)

    const disabledFingerprintRegeneration = await fetch(`http://127.0.0.1:${port}/api/instances/missing/regenerate-fingerprint`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(disabledFingerprintRegeneration.status, 410)

    const license = await fetch(`http://127.0.0.1:${port}/api/license/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(license.status, 200)
    const licensePayload = await license.json() as { ok: boolean; license?: { state?: string; source?: string } }
    assert.equal(licensePayload.ok, true)
    assert.equal(licensePayload.license?.state, 'unconfigured')
    assert.equal(licensePayload.license?.source, 'none')
  } finally {
    child.kill()
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
    assert.ok(dataDir.startsWith(os.tmpdir()))
    rmSync(dataDir, { recursive: true, force: true })
  }
})
