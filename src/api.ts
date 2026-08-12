// 前端 API 封装 —— 与后端 /api 路由一一对应

/** 档案级指纹策略配置 */
export interface FingerprintConfig {
  enabled: boolean
  proxyList: string[]
  timezonePool: string[]
  languagePool: string[]
  generateHostname: boolean
  customUserAgent: string
  region: 'domestic' | 'international' | 'mixed'
}

/** 实例独立指纹 */
export interface InstanceFingerprint {
  timezone: string
  language: string
  locale: string
  proxy: string
  hostname: string
  userAgent: string
  platform: string
  hardwareConcurrency: number
  deviceMemory: number
  screenWidth: number
  screenHeight: number
  colorDepth: number
  webglVendor: string
  webglRenderer: string
  canvasSeed: number
  audioSeed: number
  machineGuid: string
}

export interface Profile {
  id: string
  name: string
  appPath: string
  appArgs: string
  workDir: string
  boxPrefix: string
  openPaths: string[]
  defaultCount: number
  cleanOnClose: boolean
  boxNameTitle: boolean
  extraIni: string
  fingerprint: FingerprintConfig
}

export interface InstanceRecord {
  id: string
  profileId: string
  index: number
  box: string
  name: string
  createdAt: number
  lastLaunchedAt: number
  fingerprint: InstanceFingerprint
}

export interface InstanceInfo {
  index: number
  box: string
  running: boolean
  pidCount: number
  pids: number[]
  fingerprint?: InstanceFingerprint
  name?: string
  createdAt?: number
  proxyAlive?: boolean | null // 代理可用性（null=无代理，true=可用，false=失效）
}

export interface LaunchResult {
  index: number
  box: string
  launched: boolean
  error?: string
}

export interface ProxyEntry {
  url: string
  host: string
  port: number
  latency: number
}

export interface AuthorizationReceipt {
  version: 1
  receiptId: string
  timestamp: string
  box: string
  status: 'inspected' | 'blocked' | 'launch-dispatched' | 'launch-failed'
  reason?: string
  authorizationHost: string
  authorizationPath: string
  authorizationQueryKeys: string[]
  callbackHost: string
  callbackPort: number
  callbackPath: string
  listenerPid: number
  instanceMainPid: number
  listenerOwnedByInstance: boolean
  browserExecutable: string
  browserProfile: string
  hasProxy: boolean
  browserPid?: number
}

// ---- API Token 管理 ----
let _apiToken = ''

async function fetchToken(): Promise<string> {
  if (_apiToken) return _apiToken
  try {
    const electronAPI = (window as any).electronAPI
    if (electronAPI && typeof electronAPI.getApiToken === 'function') {
      _apiToken = String(await electronAPI.getApiToken() || '')
      return _apiToken
    }
    const r = await fetch('/api/token')
    const j = await r.json()
    _apiToken = j.token || ''
  } catch {
    _apiToken = ''
  }
  return _apiToken
}

async function req(url: string, opts?: RequestInit): Promise<any> {
  // 首次请求前获取 token（/api/token 自身不需要认证）
  if (!_apiToken && !url.includes('/api/token')) {
    await fetchToken()
  }
  const headers: Record<string, string> = { ...(opts?.headers as any) }
  if (_apiToken) headers['Authorization'] = `Bearer ${_apiToken}`

  // 超时保护：restart 等操作可能需要较长时间（终止+清理+重启），给 120 秒
  // 如果调用方已提供 signal（如 fetchFreeProxies 的 300 秒超时），则不覆盖
  const hasOwnSignal = !!opts?.signal
  const controller = new AbortController()
  const timeoutId = hasOwnSignal ? null : setTimeout(() => controller.abort(), 45000)
  let r: Response
  try {
    r = await fetch(url, { ...opts, headers, ...(hasOwnSignal ? {} : { signal: controller.signal }) })
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { ok: false, error: '请求超时（120秒），后端可能正在处理中，请稍后刷新查看结果' }
    }
    return { ok: false, error: e?.message || '网络请求失败，请确认后端已启动' }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
  const text = await r.text()
  let j: any = {}
  try {
    j = text ? JSON.parse(text) : {}
  } catch {
    j = { ok: false, error: text }
  }
  return j
}

export const api = {
  // 引擎状态（自研引擎，纯用户态，始终就绪）
  async getEngineStatus(): Promise<{ ok: boolean; ready: boolean; version: string }> {
    return req('/api/engine/status')
  },

  async getProfiles(): Promise<{ ok: boolean; profiles: Profile[] }> {
    return req('/api/profiles')
  },
  async createProfile(p: Omit<Profile, 'id'>) {
    return req('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    })
  },
  async updateProfile(id: string, p: Omit<Profile, 'id'>) {
    return req(`/api/profiles/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    })
  },
  async deleteProfile(id: string) {
    return req(`/api/profiles/${id}`, { method: 'DELETE' })
  },
  async launch(id: string, count: number, fingerprintEnabled?: boolean, tempProxyList?: string[]): Promise<{ ok: boolean; results: LaunchResult[]; error?: string }> {
    return req(`/api/profiles/${id}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, fingerprintEnabled, tempProxyList }),
    })
  },
  async getInstances(id: string, count: number): Promise<{ ok: boolean; instances: InstanceInfo[]; error?: string }> {
    return req(`/api/profiles/${id}/instances?count=${count}`)
  },
  async restart(id: string, index: number, fingerprintEnabled?: boolean) {
    return req(`/api/profiles/${id}/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index, fingerprintEnabled }),
    })
  },
  async terminate(box: string) {
    return req(`/api/instances/${encodeURIComponent(box)}/terminate`, { method: 'POST' })
  },
  async clean(box: string) {
    return req(`/api/instances/${encodeURIComponent(box)}/clean`, { method: 'POST' })
  },
  async remove(box: string) {
    return req(`/api/instances/${encodeURIComponent(box)}/remove`, { method: 'POST' })
  },
  async regenerateFingerprint(box: string): Promise<{ ok: boolean; fingerprint?: InstanceFingerprint; proxyAllocated?: boolean; message?: string; error?: string }> {
    return req(`/api/instances/${encodeURIComponent(box)}/regenerate-fingerprint`, { method: 'POST' })
  },
  async getAllInstances(): Promise<{ ok: boolean; instances: InstanceRecord[] }> {
    return req('/api/instances')
  },
  async authorization(box: string, url: string, launch: boolean): Promise<{ ok: boolean; receipt?: AuthorizationReceipt; error?: string }> {
    return req(`/api/instances/${encodeURIComponent(box)}/authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, launch }),
    })
  },
  async authorizationReceipts(box: string): Promise<{ ok: boolean; receipts: AuthorizationReceipt[]; error?: string }> {
    return req(`/api/instances/${encodeURIComponent(box)}/authorization-receipts`)
  },
  async openInInstanceBrowser(box: string, url: string): Promise<{ ok: boolean; browser?: { browserPid: number; browserProfile: string }; error?: string }> {
    return req(`/api/instances/${encodeURIComponent(box)}/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  },
  async fetchFreeProxies(count?: number): Promise<{ ok: boolean; proxies: ProxyEntry[]; count: number; target?: number; error?: string }> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new DOMException('前端超时（5分钟）', 'TimeoutError')), 300000)
    try {
      return await req('/api/proxy-pool/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
        signal: ctrl.signal,
      } as RequestInit)
    } catch (e: any) {
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      return {
        ok: false,
        proxies: [],
        count: 0,
        error: isTimeout
          ? '获取超时（超过5分钟），免费代理源响应过慢，请稍后重试'
          : '网络请求失败，请确认后端已启动',
      }
    } finally {
      clearTimeout(timer)
    }
  },
  /** 分配今日未用过的代理（隔离IP功能，自动去重 + 标记已用） */
  async allocateProxies(count: number): Promise<{ ok: boolean; proxies: string[]; count: number; target?: number; usedToday?: number; error?: string }> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new DOMException('前端超时（5分钟）', 'TimeoutError')), 300000)
    try {
      return await req('/api/proxy-pool/allocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
        signal: ctrl.signal,
      } as RequestInit)
    } catch (e: any) {
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      return {
        ok: false,
        proxies: [],
        count: 0,
        error: isTimeout
          ? '分配超时（超过5分钟），免费代理源响应过慢，请稍后重试'
          : '网络请求失败，请确认后端已启动',
      }
    } finally {
      clearTimeout(timer)
    }
  },
  async pick(kind: 'folder' | 'file', title: string): Promise<{ ok: boolean; path: string; cancelled: boolean }> {
    const electronAPI = (window as any).electronAPI
    if (electronAPI && typeof electronAPI.pick === 'function') {
      try {
        const r = await electronAPI.pick(kind, title)
        return { ok: true, path: r?.path || '', cancelled: !!r?.cancelled }
      } catch {}
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    try {
      return await req(`/api/pick?kind=${kind}&title=${encodeURIComponent(title)}`, {
        signal: ctrl.signal,
      } as RequestInit)
    } catch {
      return { ok: false, path: '', cancelled: false }
    } finally {
      clearTimeout(timer)
    }
  },
}
