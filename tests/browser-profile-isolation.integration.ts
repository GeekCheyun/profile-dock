import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import WebSocket from 'ws'
import { detectBrowserPath } from '../server/engine.js'

async function waitForPage(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const pages = await response.json() as Array<{ type: string; webSocketDebuggerUrl?: string }>
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page?.webSocketDebuggerUrl) return page as { webSocketDebuggerUrl: string }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Chrome CDP ${port} 未就绪`)
}

async function withBrowser<T>(browserPath: string, profile: string, port: number, action: (socket: WebSocket) => Promise<T>): Promise<T> {
  const child = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  try {
    const page = await waitForPage(port)
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    try { return await action(socket) } finally { socket.close() }
  } finally {
    if (!child.killed) child.kill()
  }
}

function cdpCall(socket: WebSocket, method: string, params: Record<string, unknown>): Promise<any> {
  const id = Math.floor(Math.random() * 1_000_000)
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data))
      if (message.id !== id) return
      socket.off('message', onMessage)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

test('真实 Chrome 两个实例的 Cookie 不互相可见', { timeout: 30000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows Chrome integration')
  const browserPath = detectBrowserPath('not-a-browser.exe')
  if (!browserPath) return t.skip('Chrome/Edge not installed')
  const root = mkdtempSync(path.join(os.tmpdir(), 'multiopen-browser-cookie-isolation-'))
  try {
    const profileOne = path.join(root, 'instance-one', 'browser-profile-v2')
    const profileTwo = path.join(root, 'instance-two', 'browser-profile-v2')
    const cookie = { name: 'multiopen_isolation', value: 'instance-one', url: 'https://isolation.invalid/' }
    const first = await withBrowser(browserPath, profileOne, 19401, async (socket) => {
      await cdpCall(socket, 'Network.setCookie', cookie)
      return cdpCall(socket, 'Network.getAllCookies', {})
    })
    const second = await withBrowser(browserPath, profileTwo, 19402, (socket) => cdpCall(socket, 'Network.getAllCookies', {}))
    assert.ok(first.cookies.some((item: { name: string; value: string }) => item.name === cookie.name && item.value === cookie.value))
    assert.equal(second.cookies.some((item: { name: string }) => item.name === cookie.name), false)
  } finally {
    assert.ok(root.startsWith(os.tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})
