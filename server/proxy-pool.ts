// 免费代理池模块
//
// 功能：
// 1. 从多个公开免费代理源抓取 HTTP 代理列表
// 2. 并发验证每个代理的可用性（通过代理请求测试 URL）
// 3. 按延迟排序，返回可用的代理
//
// 重要提示（务必告知用户）：
// - 免费代理来自互联网上暴露的开放代理，质量参差不齐，极不稳定
// - 代理可能随时失效，速度慢，且存在流量被嗅探的风险
// - 仅适用于临时/演示场景，正式多账号防关联请使用付费代理
//
// 技术说明：
// - 抓取用 Node https 核心模块直连（不走 shell，避免引号问题）
// - 验证用 http.request 通过 HTTP 代理请求 HTTP 测试目标（代理转发完整 URL）
// - 多源并发抓取 + 去重，单源失败不影响整体
// - 并发验证，限制并发数避免资源耗尽

import http from 'node:http'
import https from 'node:https'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './util.js'

export interface ProxyEntry {
  url: string // http://host:port
  host: string
  port: number
  latency: number // 验证响应耗时(ms)
}

// 免费代理数据源（均为公开免费列表，返回 ip:port 纯文本）
const SOURCES = [
  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
]

// HTTPS 隧道测试目标（实际应用如 Trae 使用 HTTPS，代理必须支持 CONNECT 方法）
// 使用多个目标容错，避免单一目标不可用导致误判
const CONNECT_TARGETS = [
  { host: 'httpbin.org', port: 443 },
  { host: 'www.google.com', port: 443 },
  { host: 'www.bing.com', port: 443 },
]

/** 用 https.get 抓取文本，自动跟随重定向，超时返回空 */
function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    const getter = (u: string, depth = 0): void => {
      if (depth > 3) return resolve('')
      const req = https.get(
        u,
        { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } },
        (res) => {
          // 跟随重定向
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            const next = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, u).href
            return getter(next, depth + 1)
          }
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => resolve(data))
          res.on('error', () => resolve(''))
        }
      )
      req.on('error', () => resolve(''))
      req.on('timeout', () => {
        req.destroy()
        resolve('')
      })
    }
    getter(url)
  })
}

/** 解析 ip:port 文本列表，去重 */
function parseProxyList(text: string): string[] {
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l) && !seen.has(l)) {
      seen.add(l)
    }
  }
  return Array.from(seen)
}

/** 从所有源抓取免费代理（并发），去重后返回 http://host:port 列表 */
export async function fetchFreeProxies(): Promise<string[]> {
  const results = await Promise.all(
    SOURCES.map(async (url) => {
      try {
        const text = await fetchText(url)
        return parseProxyList(text)
      } catch {
        return []
      }
    })
  )
  const seen = new Set<string>()
  for (const list of results) {
    for (const p of list) seen.add(p)
  }
  return Array.from(seen).map((p) => `http://${p}`)
}

/** 校验 IP 是否为内网/保留地址，防止 SSRF 攻击内网服务 */
function isPrivateIp(host: string): boolean {
  // IPv4 校验
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    // 127.0.0.0/8 回环、10.0.0.0/8 内网、192.168.0.0/16 内网、172.16.0.0/12 内网
    // 169.254.0.0/16 链路本地、0.0.0.0/8 本机、100.64.0.0/10 CGN
    if (a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) {
      return true
    }
    return false
  }
  // IPv6 回环、IPv6 本地
  if (/^(::1|fe80::|fc00::|fd00::)/i.test(host)) return true
  // localhost
  if (/^localhost$/i.test(host)) return true
  return false
}

/**
 * 测试单个 HTTP 代理是否支持 HTTPS 隧道（CONNECT 方法）
 *
 * 关键修复：之前用 HTTP GET 测试（http://httpbin.org/ip），只能验证代理支持 HTTP 转发。
 * 但实际应用（Trae/VSCode）使用 HTTPS，代理必须支持 CONNECT 方法建立隧道。
 * 很多免费代理支持 HTTP 转发但不支持 CONNECT → 验证通过但实际使用失败。
 *
 * 现在改为发送 CONNECT 请求，代理返回 200 表示支持 HTTPS 隧道。
 * 使用多个测试目标容错，任一目标成功即判定可用。
 *
 * 注意：Node.js 的 http.request 对 CONNECT 方法有特殊处理：
 * 响应不会触发回调函数，而是触发 'connect' 事件（req.on('connect', ...)）
 */
function testProxy(host: string, port: number, timeoutMs = 4000): Promise<{ alive: boolean; latency: number }> {
  // SSRF 防护：拒绝内网/保留地址，防止代理源注入内网 IP 探测内网服务
  if (isPrivateIp(host)) {
    return Promise.resolve({ alive: false, latency: 0 })
  }

  // 逐个尝试 CONNECT 目标，任一成功即可用
  return new Promise((resolve) => {
    let idx = 0
    let settled = false

    const tryNext = (): void => {
      if (idx >= CONNECT_TARGETS.length || settled) {
        if (!settled) resolve({ alive: false, latency: 0 })
        return
      }
      const target = CONNECT_TARGETS[idx++]
      const start = Date.now()
      const req = http.request({
        host, // 代理服务器地址
        port, // 代理服务器端口
        method: 'CONNECT',
        path: `${target.host}:${target.port}`, // CONNECT 请求的目标 host:port
        timeout: timeoutMs,
      })

      // CONNECT 方法的响应通过 'connect' 事件接收（不是回调函数）
      req.on('connect', (res, socket) => {
        // CONNECT 成功返回 200，失败返回 405/502 等
        const alive = res.statusCode === 200
        // 立即销毁隧道连接，避免保持打开
        socket.destroy()
        if (alive && !settled) {
          settled = true
          resolve({ alive: true, latency: Date.now() - start })
        } else {
          tryNext()
        }
      })

      req.on('error', () => tryNext())
      req.on('timeout', () => {
        req.destroy()
        tryNext()
      })
      req.end()
    }
    tryNext()
  })
}

/**
 * 并发验证代理列表，返回可用代理（按延迟升序）
 * @param proxies 代理 URL 列表
 * @param opts.concurrency 并发数（默认 30）
 * @param opts.limit 返回上限（默认 30）
 * @param opts.onProgress 进度回调
 */
export async function validateProxies(
  proxies: string[],
  opts: {
    concurrency?: number
    limit?: number
    onProgress?: (done: number, total: number, alive: number) => void
  } = {}
): Promise<ProxyEntry[]> {
  const total = proxies.length
  if (total === 0) return []
  const concurrency = Math.min(opts.concurrency ?? 50, total)
  const limit = opts.limit ?? 30
  const results: ProxyEntry[] = []
  let cursor = 0
  let done = 0
  let alive = 0

  // 已找到目标数量可用代理时提前结束（严格按 limit，找到即停）
  const earlyStopTarget = limit
  let stopped = false

  const worker = async (): Promise<void> => {
    while (cursor < total && !stopped) {
      const i = cursor++
      const m = proxies[i].match(/^http:\/\/([^:]+):(\d+)$/)
      if (!m) {
        done++
        opts.onProgress?.(done, total, alive)
        continue
      }
      const host = m[1]
      const port = Number(m[2])
      const r = await testProxy(host, port)
      done++
      if (r.alive) {
        alive++
        results.push({ url: proxies[i], host, port, latency: r.latency })
        // 已找到足够可用代理，通知其他 worker 停止
        if (alive >= earlyStopTarget) {
          stopped = true
        }
      }
      opts.onProgress?.(done, total, alive)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  results.sort((a, b) => a.latency - b.latency)
  return results.slice(0, limit)
}

/**
 * 一键抓取 + 验证免费代理（完整流程）
 * @param opts.targetCount 目标可用代理数量，找到即停止验证（默认 30）
 * @param onProgress 阶段进度回调
 */
export async function fetchAndValidateFreeProxies(
  opts: { targetCount?: number; onProgress?: (stage: string, done: number, total: number, alive: number) => void } = {}
): Promise<ProxyEntry[]> {
  const targetCount = Math.max(1, opts.targetCount ?? 30)
  const onProgress = opts.onProgress
  onProgress?.('正在抓取免费代理列表...', 0, 0, 0)
  const raw = await fetchFreeProxies()
  if (raw.length === 0) {
    return []
  }
  onProgress?.(`已抓取 ${raw.length} 个，目标 ${targetCount} 个，开始验证...`, 0, raw.length, 0)
  const valid = await validateProxies(raw, {
    concurrency: 50,
    limit: targetCount,
    onProgress: (d, t, a) => onProgress?.(`验证中 ${d}/${t}（已找到 ${a}/${targetCount}）`, d, t, a),
  })
  return valid
}

// ==================== 今日去重代理分配 ====================
//
// 需求：多开实例需要独立 IP，同一代理今日不能分配给多个实例，否则 IP 重复被关联检测。
//
// 设计：
// - 持久化文件 data/proxy-usage.json 记录每日已用代理 URL
// - 格式: { "2026-08-02": ["http://1.2.3.4:8080", ...], "2026-08-01": [...] }
// - 分配时排除今日已用，分配成功后标记为已用
// - 自动清理超过 7 天的记录（避免文件无限增长）
// - 验证仍用 CONNECT 方法（只保留支持 HTTPS 隧道的代理）

const USAGE_FILE = path.join(DATA_DIR, 'proxy-usage.json')
const USAGE_RETENTION_DAYS = 7

/** 获取今日日期字符串（本地时区，YYYY-MM-DD） */
function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 读取代理使用记录（自动清理过期记录） */
function loadProxyUsage(): Record<string, string[]> {
  if (!existsSync(USAGE_FILE)) return {}
  try {
    const raw = readFileSync(USAGE_FILE, 'utf-8')
    const data = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return {}

    // 清理超过保留期的记录
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - USAGE_RETENTION_DAYS)
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
    let changed = false
    for (const key of Object.keys(data)) {
      if (key < cutoffStr) {
        delete data[key]
        changed = true
      }
    }
    if (changed) saveProxyUsage(data)
    return data
  } catch {
    return {}
  }
}

/** 保存代理使用记录 */
function saveProxyUsage(data: Record<string, string[]>): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf-8')
  } catch (e: any) {
    console.error('[ProxyPool] 保存代理使用记录失败:', e?.message || e)
  }
}

/** 标记代理为今日已用 */
function markProxiesUsed(urls: string[]): void {
  const data = loadProxyUsage()
  const today = todayStr()
  if (!data[today]) data[today] = []
  for (const url of urls) {
    if (url && !data[today].includes(url)) {
      data[today].push(url)
    }
  }
  saveProxyUsage(data)
}

/**
 * 分配今日未用过的可用代理（自动抓取 + 验证 + 去重）
 *
 * 流程：
 * 1. 读取今日已用代理列表
 * 2. 抓取免费代理池
 * 3. 排除今日已用的代理
 * 4. 并发验证（CONNECT 方法，只保留支持 HTTPS 隧道的）
 * 5. 取 count 个，标记为今日已用
 *
 * @param count 需要的代理数量
 * @param onProgress 进度回调
 * @returns 分配结果（proxies=代理URL列表，usedToday=今日已用总数）
 */
export async function allocateProxies(
  count: number,
  onProgress?: (stage: string, done: number, total: number, alive: number) => void
): Promise<{ proxies: string[]; usedToday: number; fetched: number }> {
  const need = Math.max(1, Math.min(50, count))
  const usage = loadProxyUsage()
  const today = todayStr()
  const usedTodaySet = new Set(usage[today] || [])
  const usedTodayCount = usedTodaySet.size

  onProgress?.('正在抓取免费代理列表...', 0, 0, 0)
  const raw = await fetchFreeProxies()
  if (raw.length === 0) {
    return { proxies: [], usedToday: usedTodayCount, fetched: 0 }
  }

  // 排除今日已用
  const candidates = raw.filter((url) => !usedTodaySet.has(url))
  onProgress?.(`已抓取 ${raw.length} 个，排除今日已用后剩余 ${candidates.length} 个，验证中...`, 0, candidates.length, 0)

  if (candidates.length === 0) {
    return { proxies: [], usedToday: usedTodayCount, fetched: raw.length }
  }

  // 验证（CONNECT 方法），目标数量 = need（找到即停）
  const valid = await validateProxies(candidates, {
    concurrency: 50,
    limit: need,
    onProgress: (d, t, a) => onProgress?.(`验证中 ${d}/${t}（已找到 ${a}/${need}）`, d, t, a),
  })

  const proxies = valid.map((v) => v.url)

  // 标记为今日已用（乐观锁定：分配即记录，防止并发启动分配到相同代理）
  if (proxies.length > 0) {
    markProxiesUsed(proxies)
  }

  return { proxies, usedToday: usedTodayCount + proxies.length, fetched: raw.length }
}
