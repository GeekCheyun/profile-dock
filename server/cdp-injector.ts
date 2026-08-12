// CDP 指纹注入引擎
//
// 通过 Chrome DevTools Protocol (CDP) 连接浏览器调试端口，
// 在每个页面加载前注入指纹覆盖脚本，实现完整的浏览器层指纹隔离。
//
// 工作流程：
// 1. 浏览器启动时通过 --remote-debugging-port=XXXX 开启 CDP
// 2. 本模块通过 HTTP GET /json/version 获取 WebSocket 调试 URL
// 3. 连接 WebSocket，发送 CDP 命令：
//    - Target.setAutoAttach: 自动附加到所有新页面
//    - Page.addScriptToEvaluateOnNewDocument: 注入指纹覆盖脚本
//    - Emulation.setTimezoneOverride: 覆盖时区
//    - Network.setUserAgentOverride: 覆盖 UA（含 sec-ch-ua）
// 4. 每个新打开的页面都会在 JS 执行前获得指纹覆盖
//
// 为什么用 CDP 而不是 hook：
// - CDP 在 V8 层注入，比 DLL hook 更稳定，不会导致浏览器崩溃
// - Page.addScriptToEvaluateOnNewDocument 保证在页面任何 JS 执行前注入
// - 可以精确控制每个指纹维度，不依赖浏览器版本内部实现

import http from 'node:http'
import WebSocket from 'ws'
import type { InstanceFingerprint } from './types.js'
import { generateFingerprintScript } from './fingerprint-script.js'

interface CdpTarget {
  id: string
  type: string
  webSocketDebuggerUrl?: string
  url?: string
}

interface PendingRequest {
  resolve: (data: any) => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
}

/**
 * CDP 客户端：连接浏览器调试端口，注入指纹覆盖
 */
export class CdpInjector {
  private ws: WebSocket | null = null
  private msgId = 1
  private pending = new Map<number, PendingRequest>()
  private fingerprint: InstanceFingerprint
  private scriptSource: string
  private port: number
  private attachedTargets = new Set<string>()
  private keepAliveTimer: NodeJS.Timeout | null = null
  private connected = false

  constructor(port: number, fingerprint: InstanceFingerprint) {
    this.port = port
    this.fingerprint = fingerprint
    this.scriptSource = generateFingerprintScript(fingerprint)
  }

  /**
   * 连接浏览器 CDP 端点并注入指纹
   * 重试最多 30 次（约 15 秒），等待浏览器完全启动
   */
  async connect(maxRetries = 30): Promise<boolean> {
    if (!this.scriptSource) {
      console.log(`[CDP] 指纹脚本为空，跳过注入 (port=${this.port})`)
      return false
    }

    // 1. 通过 HTTP 获取浏览器 WebSocket URL
    let wsUrl: string | null = null
    for (let i = 0; i < maxRetries; i++) {
      try {
        wsUrl = await this.getBrowserWsUrl()
        if (wsUrl) break
      } catch {
        // 浏览器还没启动好
      }
      await sleep(500)
    }

    if (!wsUrl) {
      console.log(`[CDP] 无法连接到调试端口 ${this.port}（重试 ${maxRetries} 次后放弃）`)
      return false
    }

    // 2. 连接 WebSocket
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(wsUrl!, {
          handshakeTimeout: 5000,
        })

        this.ws.on('open', async () => {
          console.log(`[CDP] WebSocket 已连接 (port=${this.port})`)
          this.connected = true

          try {
            // 3. 启用 Target 域，设置自动附加到所有页面
            await this.send('Target.setDiscoverTargets', { discover: true })
            await this.send('Target.setAutoAttach', {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
            })

            // 4. 获取已有页面并注入
            const targets = await this.getTargets()
            for (const target of targets) {
              if (target.type === 'page' && target.webSocketDebuggerUrl) {
                await this.injectIntoPage(target.id, target.webSocketDebuggerUrl)
              }
            }

            // 5. 启动心跳保持连接
            this.startKeepAlive()

            console.log(`[CDP] 指纹注入完成 (port=${this.port}, targets=${targets.length})`)
            resolve(true)
          } catch (e: any) {
            console.log(`[CDP] 注入过程出错: ${e?.message || e}`)
            resolve(false)
          }
        })

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data.toString())
        })

        this.ws.on('error', (err) => {
          console.log(`[CDP] WebSocket 错误: ${err.message}`)
          if (!this.connected) resolve(false)
        })

        this.ws.on('close', () => {
          console.log(`[CDP] WebSocket 已关闭 (port=${this.port})`)
          this.connected = false
          this.stopKeepAlive()
        })
      } catch (e: any) {
        console.log(`[CDP] 连接异常: ${e?.message || e}`)
        resolve(false)
      }
    })
  }

  /**
   * 处理 CDP 消息
   */
  private handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw)

      // 响应消息：匹配 pending 请求
      if (msg.id && this.pending.has(msg.id)) {
        const req = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(req.timeout)
        if (msg.error) {
          req.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        } else {
          req.resolve(msg.result)
        }
        return
      }

      // 事件消息
      if (msg.method) {
        this.handleEvent(msg.method, msg.params)
      }
    } catch {
      // 忽略解析错误
    }
  }

  /**
   * 处理 CDP 事件
   */
  private handleEvent(method: string, params: any) {
    switch (method) {
      case 'Target.attachedToTarget': {
        // 新页面被附加：注入指纹脚本
        const targetInfo = params.targetInfo
        const sessionId = params.sessionId
        if (targetInfo && targetInfo.type === 'page' && sessionId) {
          this.injectIntoSession(sessionId).catch(() => {})
        }
        break
      }
    }
  }

  /**
   * 向新附加的页面 session 注入指纹脚本
   */
  private async injectIntoSession(sessionId: string): Promise<void> {
    try {
      // 先恢复页面执行（waitForDebuggerOnStart=true 时页面暂停在开头）
      await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId)

      // 注入指纹覆盖脚本（在每个新文档创建时自动执行）
      if (this.scriptSource) {
        await this.send('Page.addScriptToEvaluateOnNewDocument', {
          source: this.scriptSource,
        }, sessionId)
      }

      // 时区覆盖（CDP 原生支持，比 JS 覆盖更可靠）
      if (this.fingerprint.timezone) {
        try {
          await this.send('Emulation.setTimezoneOverride', {
            timezoneId: this.fingerprint.timezone,
          }, sessionId)
        } catch {
          // 某些时区可能不被支持，忽略
        }
      }

      // UA 覆盖（包含 sec-ch-ua 头）
      if (this.fingerprint.userAgent) {
        try {
          await this.send('Network.setUserAgentOverride', {
            userAgent: this.fingerprint.userAgent,
            acceptLanguage: this.fingerprint.language || undefined,
            platform: this.fingerprint.platform || undefined,
          }, sessionId)
        } catch {
          // 忽略
        }
      }

      console.log(`[CDP] 已注入指纹到新页面 (session=${sessionId})`)
    } catch (e: any) {
      console.log(`[CDP] 注入新页面失败: ${e?.message || e}`)
    }
  }

  /**
   * 直接连接到页面目标的 WebSocket 并注入
   */
  private async injectIntoPage(targetId: string, wsUrl: string): Promise<void> {
    if (this.attachedTargets.has(targetId)) return
    this.attachedTargets.add(targetId)

    return new Promise((resolve) => {
      try {
        const pageWs = new WebSocket(wsUrl, { handshakeTimeout: 5000 })
        let pageMsgId = 1
        const pagePending = new Map<number, (data: any) => void>()

        pageWs.on('open', async () => {
          try {
            const sendCmd = (method: string, params: any = {}): Promise<any> => {
              return new Promise((res) => {
                const id = pageMsgId++
                pagePending.set(id, res)
                pageWs.send(JSON.stringify({ id, method, params }))
                setTimeout(() => { pagePending.delete(id); res(null) }, 5000)
              })
            }

            // 注入指纹脚本
            if (this.scriptSource) {
              await sendCmd('Page.addScriptToEvaluateOnNewDocument', { source: this.scriptSource })
            }

            // 时区覆盖
            if (this.fingerprint.timezone) {
              await sendCmd('Emulation.setTimezoneOverride', { timezoneId: this.fingerprint.timezone })
            }

            // UA 覆盖
            if (this.fingerprint.userAgent) {
              await sendCmd('Network.setUserAgentOverride', {
                userAgent: this.fingerprint.userAgent,
                acceptLanguage: this.fingerprint.language || undefined,
                platform: this.fingerprint.platform || undefined,
              })
            }

            console.log(`[CDP] 已注入指纹到页面 ${targetId}`)
            pageWs.close()
            resolve()
          } catch (e) {
            pageWs.close()
            resolve()
          }
        })

        pageWs.on('message', (data: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(data.toString())
            if (msg.id && pagePending.has(msg.id)) {
              pagePending.get(msg.id)!(msg.result)
              pagePending.delete(msg.id)
            }
          } catch {}
        })

        pageWs.on('error', () => resolve())
      } catch {
        resolve()
      }
    })
  }

  /**
   * 发送 CDP 命令
   */
  private send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'))
        return
      }

      const id = this.msgId++
      const msg: any = { id, method, params }
      if (sessionId) msg.sessionId = sessionId

      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timeout: ${method}`))
      }, 10000)

      this.pending.set(id, { resolve, reject, timeout })
      this.ws.send(JSON.stringify(msg))
    })
  }

  /**
   * 通过 HTTP 获取浏览器 WebSocket 调试 URL
   */
  private getBrowserWsUrl(): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${this.port}/json/version`,
        { timeout: 3000 },
        (res) => {
          let data = ''
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            try {
              const info = JSON.parse(data)
              resolve(info.webSocketDebuggerUrl || null)
            } catch {
              resolve(null)
            }
          })
        }
      )
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }

  /**
   * 获取所有页面目标
   */
  private async getTargets(): Promise<CdpTarget[]> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${this.port}/json/list`,
        { timeout: 3000 },
        (res) => {
          let data = ''
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            try {
              const targets: CdpTarget[] = JSON.parse(data)
              resolve(targets.filter((t) => t.type === 'page'))
            } catch {
              resolve([])
            }
          })
        }
      )
      req.on('error', () => resolve([]))
      req.on('timeout', () => { req.destroy(); resolve([]) })
    })
  }

  /**
   * 心跳保持连接（每 30 秒发一个 Target.getTargets）
   */
  private startKeepAlive() {
    this.stopKeepAlive()
    this.keepAliveTimer = setInterval(async () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          await this.send('Target.getTargets')
        } catch {
          // 连接可能已断开
        }
      }
    }, 30000)
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  /**
   * 断开 CDP 连接
   */
  disconnect() {
    this.stopKeepAlive()
    this.connected = false
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
    // 清理 pending 请求
    for (const [id, req] of this.pending) {
      clearTimeout(req.timeout)
      req.reject(new Error('Disconnected'))
    }
    this.pending.clear()
  }
}

/** 调试端口分配器（避免端口冲突） */
const usedPorts = new Set<number>()
const BASE_DEBUG_PORT = 9300

export function allocateDebugPort(): number {
  for (let port = BASE_DEBUG_PORT; port < BASE_DEBUG_PORT + 200; port++) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port)
      return port
    }
  }
  // 超出范围，复用（极端情况）
  return BASE_DEBUG_PORT
}

export function releaseDebugPort(port: number) {
  usedPorts.delete(port)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
