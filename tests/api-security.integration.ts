import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
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

    const untrustedOrigin = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'https://attacker.invalid' },
    })
    assert.equal(untrustedOrigin.status, 403)

    const authorized = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(authorized.status, 200)

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
