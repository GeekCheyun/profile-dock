import http from 'node:http'
import https from 'node:https'

export interface TrustedEgress {
  protocol: 'http:' | 'https:'
  host: string
  port: number
  endpoint: string
}

export interface EgressVerification {
  verified: boolean
  externalIp?: string
  latencyMs?: number
  error?: string
}

export function parseTrustedEgress(raw: string): TrustedEgress {
  const value = String(raw || '').trim()
  const url = new URL(value.includes('://') ? value : `http://${value}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('出口仅支持 http/https CONNECT 代理')
  if (!url.hostname || url.username || url.password) throw new Error('出口地址不得包含账号、密码或空主机名')
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('出口地址只能包含协议、主机和端口')
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('出口端口无效')
  return {
    protocol: url.protocol,
    host: url.hostname,
    port,
    endpoint: `${url.protocol}//${url.hostname}:${port}`,
  }
}

/**
 * 验证可信出口确实能建立 HTTPS 隧道并返回外部出口地址。
 * 这是出口服务验证，不等于目标应用自身全部流量已验证；调用方不得越级宣传。
 */
export async function verifyTrustedEgress(raw: string, timeoutMs = 5000): Promise<EgressVerification> {
  let proxy: TrustedEgress
  try { proxy = parseTrustedEgress(raw) } catch (error: any) { return { verified: false, error: error?.message || String(error) } }
  const start = Date.now()
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value: EgressVerification) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const requestFactory = proxy.protocol === 'https:' ? https : http
    const request = requestFactory.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: 'httpbin.org:443',
      timeout: timeoutMs,
      ...(proxy.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
    } as any)
    const timer = setTimeout(() => { request.destroy(); finish({ verified: false, error: '出口连接超时' }) }, timeoutMs)
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer)
        socket.destroy()
        finish({ verified: false, error: `出口 CONNECT 返回 ${response.statusCode}` })
        return
      }
      const probe = https.request({
        host: 'httpbin.org',
        path: '/ip',
        method: 'GET',
        socket,
        agent: false,
        timeout: timeoutMs,
        rejectUnauthorized: true,
      } as any, (result) => {
        let body = ''
        result.setEncoding('utf8')
        result.on('data', (chunk) => { body += chunk })
        result.on('end', () => {
          clearTimeout(timer)
          socket.destroy()
          try {
            const externalIp = String(JSON.parse(body)?.origin || '').split(',')[0].trim()
            finish(externalIp
              ? { verified: true, externalIp, latencyMs: Date.now() - start }
              : { verified: false, error: '出口响应未包含外部地址' })
          } catch {
            finish({ verified: false, error: '出口响应不是有效 JSON' })
          }
        })
      })
      probe.on('timeout', () => { probe.destroy(); socket.destroy(); clearTimeout(timer); finish({ verified: false, error: '出口 HTTPS 探针超时' }) })
      probe.on('error', () => { socket.destroy(); clearTimeout(timer); finish({ verified: false, error: '出口 HTTPS 探针失败' }) })
      probe.end()
    })
    request.on('timeout', () => { request.destroy(); clearTimeout(timer); finish({ verified: false, error: '出口 CONNECT 超时' }) })
    request.on('error', () => { clearTimeout(timer); finish({ verified: false, error: '出口 CONNECT 失败' }) })
    request.end()
  })
}
