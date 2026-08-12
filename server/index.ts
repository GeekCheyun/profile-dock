import express from 'express'
import path from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import crypto from 'node:crypto'
import { DATA_DIR, ROOT, run, q, isAdmin, openBrowser } from './util.js'
import { Store } from './profiles.js'
import * as engine from './engine.js'
import {
  inspectAuthorizationRouting,
  launchAuthorizationInInstance,
  readAuthorizationReceipts,
  type AuthorizationRoutingContext,
} from './auth-routing.js'
import type { Profile } from './types.js'
import { launchUrlInInstanceBrowser } from './instance-browser.js'
import { createDiagnosticReport } from './diagnostics.js'
import { getLicenseSnapshot } from './license.js'

const store = new Store()
const port = store.config.port || 17890
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '32kb' }))

// The control API is desktop-local only. Bind and request validation both use
// loopback so another LAN host or a DNS-rebinding origin cannot acquire the
// local bearer token and operate instances.
const allowedHosts = new Set([
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`,
  '127.0.0.1:5173',
  'localhost:5173',
])
const allowedOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
])
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase()
  const origin = String(req.headers.origin || '').toLowerCase()
  if (!allowedHosts.has(host)) return res.status(421).json({ ok: false, error: '仅允许本机控制端访问' })
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ ok: false, error: '请求来源不受信任' })
  res.setHeader('Cache-Control', 'no-store')
  next()
})

// ---- H2 安全：API Token 认证 ----
// 启动时生成随机 token，前端通过 electronAPI 获取后携带在请求头
const TOKEN_FILE = path.join(DATA_DIR, '.api-token')
function getApiToken(): string {
  try {
    if (existsSync(TOKEN_FILE)) {
      return readFileSync(TOKEN_FILE, 'utf-8').trim()
    }
  } catch {}
  const token = crypto.randomBytes(32).toString('hex')
  try {
    mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
    writeFileSync(TOKEN_FILE, token, { encoding: 'utf-8', mode: 0o600 })
  } catch {}
  return token
}
const inheritedToken = String(process.env.MULTIOPEN_API_TOKEN || '')
const API_TOKEN = /^[a-f0-9]{64}$/i.test(inheritedToken) ? inheritedToken : getApiToken()

// API token 校验中间件
app.use('/api', (req, res, next) => {
  // 健康检查和 token 获取不需要认证
  if (req.path === '/health') return next()
  if (req.path === '/token' && !process.env.ELECTRON_DESKTOP) return next()
  const token = req.headers['authorization']?.replace('Bearer ', '') || ''
  if (token !== API_TOKEN) {
    return res.status(401).json({ ok: false, error: '未授权' })
  }
  next()
})

const ok = (data: any = {}) => ({ ok: true, ...data })
const fail = (error: string, extra: any = {}) => ({ ok: false, error, ...extra })

const asyncHandler =
  (fn: (req: express.Request, res: express.Response) => Promise<any>) =>
  (req: express.Request, res: express.Response) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      console.error('[多开工具][route] 未捕获异常:', e)
      if (!res.headersSent) res.status(500).json(fail(e?.message || String(e)))
    })
  }

function bodyToProfile(input: any): Omit<Profile, 'id'> {
  const fp = input?.fingerprint || {}
  return {
    name: String(input?.name ?? '').trim(),
    appPath: String(input?.appPath ?? '').trim(),
    appArgs: String(input?.appArgs ?? '').trim(),
    workDir: String(input?.workDir ?? '').trim(),
    boxPrefix: String(input?.boxPrefix ?? '').trim() || 'App',
    openPaths: Array.isArray(input?.openPaths) ? input.openPaths.map(String) : [],
    defaultCount: Math.max(1, Math.min(50, Number(input?.defaultCount) || 1)),
    // Instance data is persistent by contract. Clearing is explicit through
    // the instance clean/delete actions, never an implicit window close.
    cleanOnClose: false,
    boxNameTitle: input?.boxNameTitle !== false,
    extraIni: String(input?.extraIni ?? ''),
    egress: input?.egress && typeof input.egress === 'object'
      ? { enabled: input.egress.enabled === true, proxyUrl: String(input.egress.proxyUrl ?? '').trim() }
      : undefined,
    fingerprint: {
      // 指纹隔离启用时，为每个实例分配独立的设备标识、代理、时区、浏览器指纹。
      // 用户应自行提供代理池；代理不可用时实例启动会被拒绝。
      enabled: fp.enabled === true,
      proxyList: Array.isArray(fp.proxyList) ? fp.proxyList.map(String) : [],
      timezonePool: Array.isArray(fp.timezonePool) ? fp.timezonePool.map(String) : [],
      languagePool: Array.isArray(fp.languagePool) ? fp.languagePool.map(String) : [],
      generateHostname: fp.generateHostname !== false,
      customUserAgent: String(fp.customUserAgent ?? ''),
      region: (fp.region === 'domestic' || fp.region === 'international') ? fp.region : 'mixed',
    },
  }
}

// ---- Token 获取（前端启动时调用）----
app.get('/api/token', (_req, res) => {
  if (process.env.ELECTRON_DESKTOP) return res.status(404).json(fail('生产模式不提供 HTTP token 端点'))
  res.json(ok({ token: API_TOKEN }))
})

// ---- 引擎状态 ----
app.get('/api/engine/status', (_req, res) => {
  res.json(ok(store.getEngineStatus()))
})

// 只返回能力状态，不返回授权材料、签名数据或任何商业服务凭据。
app.get('/api/license/status', (_req, res) => {
  res.json(ok({ license: getLicenseSnapshot() }))
})

// ---- 档案 CRUD ----
app.get('/api/profiles', (_req, res) => {
  res.json(ok({ profiles: store.list() }))
})

app.post('/api/profiles', (req, res) => {
  const profile = store.create(bodyToProfile(req.body))
  res.json(ok({ profile }))
})

app.put('/api/profiles/:id', (req, res) => {
  const updated = store.update(req.params.id, bodyToProfile(req.body))
  if (!updated) return res.status(404).json(fail('档案不存在'))
  res.json(ok({ profile: updated }))
})

app.delete('/api/profiles/:id', (req, res) => {
  if (store.remove(req.params.id)) return res.json(ok())
  res.status(404).json(fail('档案不存在'))
})

// ---- 多开操作 ----
app.post('/api/profiles/:id/launch', asyncHandler(async (req, res) => {
  const profile = store.get(req.params.id)
  if (!profile) return res.status(404).json(fail('档案不存在'))
  const count = Math.max(1, Math.min(50, Number(req.body?.count) || profile.defaultCount))
  const results = await store.launch(profile, count)
  res.json(ok({ results }))
}))

app.get('/api/profiles/:id/instances', asyncHandler(async (req, res) => {
  const profile = store.get(req.params.id)
  if (!profile) return res.status(404).json(fail('档案不存在'))
  const count = Math.max(1, Math.min(50, Number(req.query.count) || profile.defaultCount))
  const instances = await store.instances(profile, count)
  res.json(ok({ instances }))
}))

app.post('/api/profiles/:id/restart', asyncHandler(async (req, res) => {
  const profile = store.get(req.params.id)
  if (!profile) return res.status(404).json(fail('档案不存在'))
  const index = Math.max(1, Number(req.body?.index) || 1)
  const r = await store.restart(profile, index)
  // 直接返回（不用 ok() 包装），使前端 r.ok 反映实际重启结果
  res.json({ ok: r.ok, error: r.ok ? undefined : r.stderr || `重启失败(code=${r.code})` })
}))

app.get('/api/instances', (_req, res) => {
  res.json(ok({ instances: store.listAllInstances() }))
})

app.get('/api/instances/:box/diagnostics', asyncHandler(async (req, res) => {
  const box = decodeURIComponent(req.params.box)
  const record = store.findInstanceByBox(box)
  if (!record) return res.status(404).json(fail('实例记录不存在'))
  const profile = store.get(record.profileId)
  const engineRecord = profile && engine.loadInstanceRecords(profile.id).find((item) => item.index === record.index)
  if (!profile || !engineRecord?.workDir) return res.status(409).json(fail('实例尚未创建运行目录'))
  const runtime = engine.listInstances(profile.id).find((item) => item.index === record.index)
  const report = createDiagnosticReport({
    profileId: profile.id,
    index: record.index,
    box,
    workDir: engineRecord.workDir,
    state: engine.loadInstanceManifest(profile.id, record.index)?.state,
    running: runtime?.running === true,
    pidCount: runtime?.pids.length || 0,
    egressConfigured: profile.egress?.enabled === true,
  })
  res.json(ok({ diagnostics: report }))
}))

app.post('/api/instances/:box/terminate', asyncHandler(async (req, res) => {
  const box = decodeURIComponent(req.params.box)
  const r = await store.terminateBox(box)
  res.json(ok({ ok: r.ok, error: r.ok ? undefined : r.stderr }))
}))

app.post('/api/instances/:box/clean', asyncHandler(async (req, res) => {
  const box = decodeURIComponent(req.params.box)
  const r = await store.deleteBoxContent(box)
  res.json(ok({ ok: r.ok, error: r.ok ? undefined : r.stderr }))
}))

app.post('/api/instances/:box/remove', asyncHandler(async (req, res) => {
  const box = decodeURIComponent(req.params.box)
  const r = await store.removeBoxConfig(box)
  res.json({ ok: r.ok, error: r.ok ? undefined : (r.stderr || '删除失败，详情见日志') })
}))

app.post('/api/instances/:box/regenerate-fingerprint', asyncHandler(async (req, res) => {
  res.status(410).json(fail('设备指纹轮换已停用；它不能把一个实例变成独立物理设备，并会破坏登录/授权状态'))
}))

function authorizationContext(box: string): AuthorizationRoutingContext | null {
  const record = store.findInstanceByBox(box)
  if (!record) return null
  const profile = store.get(record.profileId)
  if (!profile) return null
  const engineRecord = engine.loadInstanceRecords(profile.id).find((item) => item.index === record.index)
  if (!engineRecord?.workDir) return null
  return {
    box,
    workDir: engineRecord.workDir,
    appPath: profile.appPath,
    instanceMainPid: engineRecord.pid,
    // Automated proxy rotation is intentionally not applied to authorization.
    // Existing explicit instance proxies remain visible in receipts but the
    // loopback callback is always direct.
    proxy: '',
  }
}

// Inspect or explicitly launch a native-app authorization URL in the instance
// browser. Full URLs/codes/challenges are never written to receipts or logs.
app.post('/api/instances/:box/authorization', asyncHandler(async (req, res) => {
  const box = decodeURIComponent(req.params.box)
  const context = authorizationContext(box)
  if (!context) return res.status(404).json(fail('实例或运行目录不存在'))
  const rawUrl = String(req.body?.url || '')
  const shouldLaunch = req.body?.launch === true
  const receipt = shouldLaunch
    ? launchAuthorizationInInstance(rawUrl, context)
    : inspectAuthorizationRouting(rawUrl, context).receipt
  const successful = receipt.status === 'inspected' || receipt.status === 'launch-dispatched'
  res.status(successful ? 200 : 409).json({ ok: successful, receipt, error: receipt.reason })
}))

app.get('/api/instances/:box/authorization-receipts', (req, res) => {
  const box = decodeURIComponent(req.params.box)
  const context = authorizationContext(box)
  if (!context) return res.status(404).json(fail('实例或运行目录不存在'))
  res.json(ok({ receipts: readAuthorizationReceipts(context.workDir) }))
})

// WorkBuddy's own shell.openExternal is resolved by Windows before this
// controller is involved. This explicit route is the no-patching path for
// opening a URL with an instance-owned browser profile.
app.post('/api/instances/:box/browser', asyncHandler(async (req, res) => {
  const box = decodeURIComponent(req.params.box)
  const record = store.findInstanceByBox(box)
  if (!record) return res.status(404).json(fail('实例记录不存在'))
  const profile = store.get(record.profileId)
  const engineRecord = profile && engine.loadInstanceRecords(profile.id).find((item) => item.index === record.index)
  if (!profile || !engineRecord?.workDir) return res.status(409).json(fail('实例尚未启动'))
  try {
    res.json(ok({ browser: launchUrlInInstanceBrowser(String(req.body?.url || ''), {
      appPath: profile.appPath,
      workDir: engineRecord.workDir,
    }) }))
  } catch (error: any) {
    res.status(400).json(fail(error?.message || '实例浏览器启动失败'))
  }
}))

// ---- 原生路径选择对话框（仅 PowerShell 兜底，开发模式用）----
app.get('/api/pick', asyncHandler(async (req, res) => {
  const kind = req.query.kind === 'file' ? 'file' : 'folder'
  const title = String(req.query.title ?? '请选择')

  const script = path.join(ROOT, 'server', 'pick.ps1')
  const r = await run(
    `powershell -STA -NoProfile -ExecutionPolicy Bypass -File ${q(script)} -Kind ${kind} -Title ${q(title)}`,
    { timeout: 120000 }
  )
  const picked = r.ok ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? '' : ''
  res.json(ok({ path: picked, cancelled: !picked }))
}))

// ---- 免费代理池 ----
app.post('/api/proxy-pool/fetch', (_req, res) => {
  res.status(410).json(fail('自动抓取免费代理已停用；不稳定代理会破坏登录回调，也不能证明独立设备'))
})

// 分配今日未用过的代理（隔离IP功能用，自动去重 + 标记已用）
app.post('/api/proxy-pool/allocate', (_req, res) => {
  res.status(410).json(fail('自动代理轮换已停用；实例隔离不应伪装成新的物理设备'))
})

app.get('/api/health', (_req, res) => res.json(ok({ ts: Date.now() })))

// ---- 静态资源 + SPA 回退 ----
const distDir = path.join(ROOT, 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res.type('text/plain').send('未构建前端。请先运行: npm install && npm run build')
  })
}

const server = app.listen(port, '127.0.0.1', async () => {
  console.log(`[多开工具] 后端已启动: http://localhost:${port}`)
  console.log(`[多开工具] 项目根目录: ${ROOT}`)
  // 清理上次中断删除留下的 *.deleting-* 残留。
  // 延迟 1.5s 再执行：清扫内部有同步遍历，先让窗口/页面加载完成，避免启动卡顿。
  setTimeout(() => {
    engine.sweepStaleDeletingDirs().catch(() => {})
  }, 1500)
  // 管理员权限会让实例无法使用输入法/文本服务，并拖慢认证网络服务
  isAdmin()
    .then((admin) => {
      if (admin) {
        console.warn(
          '[多开工具] 警告：当前以管理员权限运行。实例将无法连接 Windows 输入法(TSF)，' +
            '无法切换中英文输入；专家等依赖登录的云端功能也可能加载失败。请改用「启动.vbs」普通权限启动。'
        )
      }
    })
    .catch(() => {})
  if (process.env.NODE_ENV === 'production' && !process.env.ELECTRON_DESKTOP) {
    await openBrowser(`http://localhost:${port}`)
  }
})
server.on('error', (e: NodeJS.ErrnoException) => {
  const msg = e.code === 'EADDRINUSE'
    ? `端口 ${port} 已被占用`
    : `后端监听出错: ${e.message}`
  console.error(`[多开工具] ${msg}`)
  ;(process as any).emit('backend-listen-error', msg)
})
