import { existsSync } from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE, DATA_DIR, ensureDataDir, readJsonWithBackup, uid, writeJsonAtomic } from './util.js'
import { generateFingerprint, generateRandomFingerprint, defaultFingerprintConfig } from './fingerprint.js'
import * as engine from './engine.js'
import type { AppConfig, Profile, InstanceInfo, InstanceRecord, InstanceFingerprint } from './types.js'
import { isLegacyFingerprintEnabled } from './runtime-policy.js'
import { MetadataStore } from './metadata-store.js'
import { assertLaunchAllowed, getLicenseSnapshot } from './license.js'

const DEFAULT_CONFIG: AppConfig = {
  port: 17890,
  profiles: [],
  instances: [],
}

export class Store {
  config: AppConfig
  private readonly launchInFlight = new Map<string, Promise<InstanceLaunchResult[]>>()
  private readonly metadata: MetadataStore

  constructor() {
    ensureDataDir()
    this.metadata = new MetadataStore(path.join(DATA_DIR, 'metadata.sqlite'))
    this.config = this.load()
  }

  load(): AppConfig {
    const sqliteConfig = this.metadata.readConfig<any>()
    if (sqliteConfig) return normalizeConfig(sqliteConfig)
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG }
    try {
      const loaded = readJsonWithBackup<any>(CONFIG_FILE)
      if (!loaded) return { ...DEFAULT_CONFIG }
      if (loaded.recoveredFromBackup) console.warn(`[Store] 配置主文件损坏，已从备份恢复读取: ${CONFIG_FILE}.bak`)
      const migrated = normalizeConfig(loaded.value)
      this.metadata.writeConfig(migrated)
      return migrated
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  save(): void {
    ensureDataDir()
    this.metadata.writeConfig(this.config)
    // 兼容旧版导出和人工恢复；SQLite 是运行时唯一元数据写入源。
    writeJsonAtomic(CONFIG_FILE, this.config)
  }

  // ---- 档案 CRUD ----
  list(): Profile[] {
    return this.config.profiles
  }

  get(id: string): Profile | undefined {
    return this.config.profiles.find((p) => p.id === id)
  }

  create(input: Omit<Profile, 'id'>): Profile {
    const profile: Profile = { ...input, id: uid() }
    this.config.profiles.push(profile)
    this.save()
    return profile
  }

  update(id: string, input: Omit<Profile, 'id'>): Profile | null {
    const idx = this.config.profiles.findIndex((p) => p.id === id)
    if (idx < 0) return null
    this.config.profiles[idx] = { ...input, id }
    this.save()
    return this.config.profiles[idx]
  }

  remove(id: string): boolean {
    const before = this.config.profiles.length
    this.config.profiles = this.config.profiles.filter((p) => p.id !== id)
    this.config.instances = this.config.instances.filter((i) => i.profileId !== id)
    if (this.config.profiles.length !== before) {
      this.save()
      return true
    }
    return false
  }

  boxName(profile: Profile, index: number): string {
    return `${profile.boxPrefix}-${index}`
  }

  // ---- 实例持久化管理（兼容 config.json + 引擎 records.json） ----

  listInstances(profileId: string): InstanceRecord[] {
    return this.config.instances.filter((i) => i.profileId === profileId)
  }

  listAllInstances(): InstanceRecord[] {
    return this.config.instances
  }

  findInstanceByBox(box: string): InstanceRecord | undefined {
    return this.config.instances.find((i) => i.box === box)
  }

  removeInstance(box: string): boolean {
    const before = this.config.instances.length
    this.config.instances = this.config.instances.filter((i) => i.box !== box)
    if (this.config.instances.length !== before) {
      this.save()
      return true
    }
    return false
  }

  upsertInstance(profile: Profile, index: number): InstanceRecord {
    const box = this.boxName(profile, index)
    const now = Date.now()
    const existing = this.config.instances.find((i) => i.box === box)

    if (existing) {
      existing.lastLaunchedAt = now
      this.save()
      return existing
    }

    const fingerprint = generateFingerprint(profile.fingerprint, index)
    const record: InstanceRecord = {
      id: uid(),
      profileId: profile.id,
      index,
      box,
      name: `${profile.name} #${index}`,
      createdAt: now,
      lastLaunchedAt: now,
      fingerprint,
    }
    this.config.instances.push(record)
    this.save()
    return record
  }

  // ---- 多开操作（使用自研引擎） ----

  /** 开启多开：在已有实例基础上追加 count 个新实例 */
  async launch(profile: Profile, count: number, opts?: { tempProxyList?: string[] }): Promise<InstanceLaunchResult[]> {
    const key = profile.id
    const previous = this.launchInFlight.get(key)
    if (previous) return previous

    const current = this.launchUnlocked(profile, count, opts)
    this.launchInFlight.set(key, current)
    try {
      return await current
    } finally {
      if (this.launchInFlight.get(key) === current) this.launchInFlight.delete(key)
    }
  }

  private async launchUnlocked(profile: Profile, count: number, opts?: { tempProxyList?: string[] }): Promise<InstanceLaunchResult[]> {
    try {
      assertLaunchAllowed(getLicenseSnapshot(), count)
    } catch (error: any) {
      return Array.from({ length: count }, (_, i) => ({
        index: i + 1,
        box: this.boxName(profile, i + 1),
        launched: false,
        error: error?.message || '许可证门禁拒绝启动',
      }))
    }
    if (!profile.appPath || !profile.appPath.trim()) {
      return Array.from({ length: count }, (_, i) => ({
        index: i + 1,
        box: this.boxName(profile, i + 1),
        launched: false,
        error: '档案未配置目标程序路径',
      }))
    }
    if (!existsSync(profile.appPath)) {
      return Array.from({ length: count }, (_, i) => ({
        index: i + 1,
        box: this.boxName(profile, i + 1),
        launched: false,
        error: `目标程序不存在：${profile.appPath}`,
      }))
    }

    // 如果传入了临时代理池（隔离IP勾选时由前端分配），用它覆盖档案的 proxyList
    // 这样不修改档案持久化配置，仅本次启动生效
    const effectiveProfile: Profile = isLegacyFingerprintEnabled() && opts?.tempProxyList && opts.tempProxyList.length > 0
      ? { ...profile, fingerprint: { ...profile.fingerprint, proxyList: opts.tempProxyList } }
      : profile

    // 计算起始 index：已有实例的最大 index + 1（追加模式，不重启已有实例）
    const existing = this.listInstances(effectiveProfile.id)
    const engineRecords = engine.loadInstanceRecords(effectiveProfile.id)
    let maxIndex = 0
    for (const rec of existing) maxIndex = Math.max(maxIndex, rec.index)
    for (const rec of engineRecords) maxIndex = Math.max(maxIndex, rec.index)
    const startIndex = maxIndex + 1

    const results: InstanceLaunchResult[] = []
    for (let i = 0; i < count; i++) {
      const index = startIndex + i
      const box = this.boxName(effectiveProfile, index)

      // 持久化实例记录到 config.json（使用 effectiveProfile 确保代理池正确）
      const record = this.upsertInstance(effectiveProfile, index)

      // 使用引擎启动实例，传入已有指纹（确保换指纹后重启使用新指纹）
      const r = await engine.launchInstance(effectiveProfile, index, record.fingerprint)
      results.push({
        index,
        box,
        launched: r.ok,
        error: r.ok ? undefined : r.error,
      })

      // 模拟人工操作延迟
      await delay(250)
    }
    return results
  }

  /** 查询实例运行状态 —— 基于持久化记录 + 引擎记录（不再用 1..count 占位，否则删除后又会加回来） */
  async instances(profile: Profile, count: number): Promise<InstanceInfo[]> {
    const persisted = this.listInstances(profile.id)
    const engineRecords = engine.loadInstanceRecords(profile.id)

    // 合并：持久化记录 + 引擎记录（仅显示真实存在的实例，count 仅用于前端默认输入框值）
    const allBoxes = new Set<string>()
    for (const rec of persisted) allBoxes.add(rec.box)
    for (const rec of engineRecords) allBoxes.add(rec.boxName)

    const boxes = Array.from(allBoxes)
    const markers = engineRecords
      .filter((record) => boxes.includes(record.boxName) && record.workDir)
      .map((record) => `--user-data-dir=${record.workDir}\\config`)
    const processSnapshot = engine.scanInstanceProcesses(markers)
    const out = boxes.map((box) => {
      const rec = persisted.find((r) => r.box === box)
      const engineRec = engineRecords.find((r) => r.boxName === box)
      const index = rec?.index ?? engineRec?.index ?? this.extractIndex(box)
      // workDir 来自引擎记录（config.json 的持久化实例不含 workDir）
      const workDir = engineRec?.workDir || ''
      // 【修复】主进程 = 带 --user-data-dir 且没有 --type= 的进程
      // 旧逻辑用 getBoxPids 查所有相关进程，关窗后 crashpad / GPU / 渲染等 helper
      // 残留会被误判为运行中。修复后只用主进程判断。
      const configDir = workDir ? `${workDir}\\config` : ''
      const marker = configDir ? `--user-data-dir=${configDir}` : ''
      const snapshot = marker ? processSnapshot.get(marker) : undefined
      const mainPid = snapshot?.mainPid || 0
      // 只用主进程判断运行状态（去掉 launcherAlive 回退）
      // 之前 launcherAlive 检查 r.pid，但 r.pid 可能是 helper 进程，关窗后仍活着 → 误判为运行中
      const running: boolean = !!(mainPid > 0 && engine.isProcessAlive(mainPid))

      let displayPids: number[] = []
      if (running && configDir) {
        const allPids = snapshot?.pids || []
        // 优先展示主进程 PID（如果还活着）
        if (mainPid > 0) {
          displayPids = [mainPid, ...allPids.filter((p: number) => p !== mainPid)]
        } else {
          displayPids = allPids
        }
      } else if (!running && configDir) {
        // 主进程已死：清理残留 helper（crashpad / GPU 等），fire-and-forget
        engine.cleanupOrphans(`--user-data-dir=${configDir}`).catch(() => {})
      }
      return {
        index,
        box,
        running,
        pidCount: displayPids.length,
        pids: displayPids,
        fingerprint: rec?.fingerprint ?? engineRec?.fingerprint,
        name: rec?.name,
        createdAt: rec?.createdAt ?? engineRec?.createdAt,
        state: engine.loadInstanceManifest(profile.id, index)?.state || (running ? 'process_ready' : 'stopped'),
      } as InstanceInfo
    })

    // 代理可用性检测：仅对运行中且有代理的实例并行检测（不阻塞列表渲染）
    const proxyChecks = isLegacyFingerprintEnabled() && profile.fingerprint.enabled ? out
      .filter((ins) => ins.running && ins.fingerprint?.proxy)
      .map(async (ins) => {
        const alive = await engine.testProxyAlive(ins.fingerprint!.proxy)
        ins.proxyAlive = alive
        // 代理失效时自动重新分配（从档案代理池或标记为失效）
        if (!alive) {
          const newProxy = await this.reassignProxyForInstance(profile, ins.box)
          if (newProxy) {
            ins.fingerprint!.proxy = newProxy
            ins.proxyAlive = true
          }
        }
      }) : []
    await Promise.all(proxyChecks)

    return out.sort((a, b) => a.index - b.index)
  }

  /**
   * 代理失效后自动重新分配：优先从档案代理池中找一个可用的代理
   * @returns 新代理 URL（空=未找到可用代理）
   */
  private async reassignProxyForInstance(profile: Profile, box: string): Promise<string> {
    const record = this.config.instances.find((i) => i.box === box)
    if (!record) return ''

    // 从档案代理池中找一个可用的代理（排除当前已失效的）
    const pool = profile.fingerprint.proxyList.filter((p) => p && p !== record.fingerprint.proxy)
    for (const candidate of pool) {
      const alive = await engine.testProxyAlive(candidate)
      if (alive) {
        record.fingerprint.proxy = candidate
        this.save()
        console.log(`[多开工具] 实例 ${box} 代理失效，已自动重新分配: ${candidate}`)
        return candidate
      }
    }
    console.log(`[多开工具] 实例 ${box} 代理失效，但档案代理池中无可用替代`)
    return ''
  }

  private extractIndex(box: string): number {
    const m = box.match(/-(\d+)$/)
    return m ? Number(m[1]) : 0
  }

  /**
   * 解析实例信息（多重回退查找）
   *
   * 列表显示合并了三个数据源（1..count 占位、config.json、引擎 records.json），
   * 但 config.json 中不一定有记录，所以删除/终止/清空操作需要多重回退查找：
   * 1. config.json 的 instances 数组
   * 2. 引擎 records.json
   * 3. 从 box 名解析（boxPrefix-index 格式）
   */
  private resolveInstance(box: string): { profileId: string; index: number; pid: number; workDir: string } | null {
    // 1. 查 config.json
    const record = this.findInstanceByBox(box)
    if (record) {
      // 顺便从引擎记录获取 PID 和 workDir
      const engineRecords = engine.loadInstanceRecords(record.profileId)
      const engineRec = engineRecords.find((r) => r.boxName === box)
      return {
        profileId: record.profileId,
        index: record.index,
        pid: engineRec?.pid || 0,
        workDir: engineRec?.workDir || '',
      }
    }

    // 2. 查引擎 records.json（遍历所有档案）
    for (const profile of this.config.profiles) {
      const engineRecords = engine.loadInstanceRecords(profile.id)
      const engineRec = engineRecords.find((r) => r.boxName === box)
      if (engineRec) {
        return { profileId: profile.id, index: engineRec.index, pid: engineRec.pid || 0, workDir: engineRec.workDir }
      }
    }

    // 3. 从 box 名解析（格式: ${boxPrefix}-${index}）
    const m = box.match(/-(\d+)$/)
    if (m) {
      const index = Number(m[1])
      for (const profile of this.config.profiles) {
        if (box.startsWith(profile.boxPrefix + '-')) {
          return { profileId: profile.id, index, pid: 0, workDir: '' }
        }
      }
    }

    return null
  }

  /** 终止实例：通过引擎杀进程树（含 box 关联的所有子进程） */
  async terminateBox(box: string): Promise<{ ok: boolean; stderr: string; code: number }> {
    const info = this.resolveInstance(box)
    if (!info) return { ok: false, stderr: '实例记录不存在', code: -1 }

    // 构造 configDir（与 engine.ts launchInstance 中的 buildArgs 一致：workDir/config）
    const configDir = info.workDir ? `${info.workDir}\\config` : ''
    // Browser instances use a separate user-data-dir and are detached from
    // WorkBuddy, so termination must scan both instance markers.
    const r = await engine.terminateInstance(info.pid, configDir, { fast: false })
    return { ok: r.ok, stderr: r.error || '', code: r.ok ? 0 : 1 }
  }

  /** 清空实例配置目录 */
  async deleteBoxContent(box: string): Promise<{ ok: boolean; stderr: string; code: number }> {
    const info = this.resolveInstance(box)
    if (!info) return { ok: false, stderr: '实例记录不存在', code: -1 }

    const r = await engine.cleanInstance(info.profileId, info.index)
    return { ok: r.ok, stderr: r.error || '', code: r.ok ? 0 : 1 }
  }

  /** 删除实例：终止进程 + 删除工作目录 + 清除记录 */
  async removeBoxConfig(box: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
    const info = this.resolveInstance(box)
    if (!info) return { ok: false, stdout: '', stderr: '实例记录不存在', code: -1 }

    const errors: string[] = []
    const configDir = info.workDir ? `${info.workDir}\\config` : ''

    // 1. 终止进程（包含 box 关联的所有子进程）
    if (info.pid || configDir) {
      const tRes = await engine.terminateInstance(info.pid, configDir, { fast: false })
      if (!tRes.ok) errors.push(`终止进程: ${tRes.error}`)
    }
    // 等待文件句柄释放：Edge/Chrome 的 BrowserMetrics (.pma) 等文件
    // 进程已由 terminateInstance 等待退出；这里只给 Windows 释放句柄一个
    // 很短的缓冲，避免删除操作长时间表现为无响应。
    await delay(250)

    // 2. 删除工作目录和引擎记录
    const dRes = await engine.deleteInstance(info.profileId, info.index)
    if (!dRes.ok) errors.push(`删除目录: ${dRes.error}`)

    // 3. 只有工作目录确认删除成功后，才删除 config.json 中的记录。
    // 删除失败时保留记录，方便用户再次重试，不制造“记录已删但数据残留”的假成功。
    if (dRes.ok) this.removeInstance(box)

    const allOk = errors.length === 0
    return {
      ok: allOk,
      stdout: '',
      stderr: errors.length ? errors.join('；') : '',
      code: allOk ? 0 : 1,
    }
  }

  /** 重启实例 */
  async restart(profile: Profile, index: number): Promise<{ ok: boolean; stderr: string; code: number }> {
    const box = this.boxName(profile, index)

    // 先终止旧进程（包含 box 关联的所有子进程）
    const engineRecords = engine.loadInstanceRecords(profile.id)
    const engineRec = engineRecords.find((r) => r.boxName === box)
    if (engineRec) {
      const configDir = `${engineRec.workDir}\\config`
      await engine.terminateInstance(engineRec.pid, configDir)
      // 等待文件锁释放：Windows 在进程退出后需要额外时间释放文件句柄，
      // 300ms 太短可能导致后续 rd /s /q 删除失败，改为 1000ms
      await delay(1000)
    }

    // 获取已保存的指纹（可能已被 regenerateFingerprint 更新为全新随机指纹）
    const record = this.config.instances.find((i) => i.box === box)
    const existingFingerprint = record?.fingerprint

    // 如果指纹已更换（regenerateFingerprint 设置了 pendingClearData），
    // 清除浏览器数据（cookies/localStorage/缓存），使平台无法通过旧会话识别为同一设备。
    // 必须在进程终止后执行（文件锁已释放），在启动新实例前执行（新实例获得干净环境）。
    if (record?.pendingClearData) {
      const cleanRes = await engine.cleanInstanceForFingerprint(profile.id, index)
      if (cleanRes.ok) {
        console.log(`[Profile] 已清除实例浏览器数据（换指纹后重置设备标识，box=${box}）`)
      } else {
        console.log(`[Profile] 清除实例数据部分失败: ${cleanRes.error}`)
      }
      record.pendingClearData = false
      this.save()
    }

    // 重新启动，传入已有指纹（确保换指纹后重启使用新指纹）
    const r = await engine.launchInstance(profile, index, existingFingerprint)
    return { ok: r.ok, stderr: r.error || '', code: r.ok ? 0 : 1 }
  }

  /** 重新生成实例指纹（完全随机，确保与之前不同） */
  /**
   * 换指纹：重新生成随机指纹 + 同步更换IP（分配今日未用代理）
   *
   * IP 是设备识别的重要维度，仅换时区/语言/UA 而不换 IP，
   * 服务器仍会通过 IP 判定为同一设备 → "设备已签到"。
   * 因此换指纹时必须同步分配今日未用的新代理。
   *
   * @returns 更新后的实例记录；proxyAllocated 表示是否成功分配了新代理
   */
  async regenerateFingerprint(profile: Profile, box: string): Promise<{ record: InstanceRecord | null; proxyAllocated: boolean; proxyError?: string }> {
    const record = this.config.instances.find((i) => i.box === box)
    if (!record) return { record: null, proxyAllocated: false }

    // 使用随机生成而非确定性生成，确保"换指纹"真正产生不同的指纹
    record.fingerprint = generateRandomFingerprint(profile.fingerprint)

    // 同步换 IP：分配今日未用的新代理
    // 失败时保留指纹更换结果（时区/语言/UA 已换），仅提示代理分配失败
    let proxyAllocated = false
    let proxyError: string | undefined
    if (isLegacyFingerprintEnabled() && profile.fingerprint.enabled) {
      try {
        const { allocateProxies } = await import('./proxy-pool.js')
        const result = await allocateProxies(1)
        if (result.proxies.length > 0) {
          record.fingerprint.proxy = result.proxies[0]
          proxyAllocated = true
        } else {
          proxyError = '今日可用代理已耗尽，IP 未更换（仅更换了环境指纹）'
        }
      } catch (e: any) {
        proxyError = '代理分配失败：' + (e?.message || e)
      }
    }

    // 标记需要清除浏览器数据：重启时清除旧 cookies/localStorage，
    // 使平台无法通过旧会话识别为同一设备（仅换指纹不够，cookies 也是设备标识）
    record.pendingClearData = true
    this.save()
    return { record, proxyAllocated, proxyError }
  }

  /** 获取引擎状态 */
  getEngineStatus(): { ready: boolean; version: string } {
    return engine.getEngineStatus()
  }
}

export interface InstanceLaunchResult {
  index: number
  box: string
  launched: boolean
  error?: string
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function normalizeProfile(raw: any): Profile | null {
  if (!raw || typeof raw !== 'object') return null
  const fp = raw.fingerprint || {}
  return {
    id: String(raw.id ?? '').trim() || uid(),
    name: String(raw.name ?? '').trim(),
    appPath: String(raw.appPath ?? '').trim(),
    appArgs: String(raw.appArgs ?? '').trim(),
    workDir: String(raw.workDir ?? '').trim(),
    boxPrefix: String(raw.boxPrefix ?? '').trim() || 'App',
    openPaths: Array.isArray(raw.openPaths) ? raw.openPaths.map(String) : [],
    defaultCount: Math.max(1, Math.min(50, Number(raw.defaultCount) || 1)),
    cleanOnClose: !!raw.cleanOnClose,
    boxNameTitle: raw.boxNameTitle !== false,
    extraIni: String(raw.extraIni ?? ''),
    egress: raw.egress && typeof raw.egress === 'object'
      ? { enabled: raw.egress.enabled === true, proxyUrl: String(raw.egress.proxyUrl ?? '').trim() }
      : undefined,
    fingerprint: {
      enabled: !!fp.enabled,
      proxyList: Array.isArray(fp.proxyList) ? fp.proxyList.map(String) : [],
      timezonePool: Array.isArray(fp.timezonePool) ? fp.timezonePool.map(String) : [],
      languagePool: Array.isArray(fp.languagePool) ? fp.languagePool.map(String) : [],
      generateHostname: fp.generateHostname !== false,
      customUserAgent: String(fp.customUserAgent ?? ''),
      region: (fp.region === 'domestic' || fp.region === 'international') ? fp.region : 'mixed',
    },
  }
}

function normalizeInstance(raw: any): InstanceRecord | null {
  if (!raw || typeof raw !== 'object') return null
  if (!raw.box || !raw.profileId) return null
  const fp = raw.fingerprint || {}
  return {
    id: String(raw.id ?? '').trim() || uid(),
    profileId: String(raw.profileId),
    index: Number(raw.index) || 1,
    box: String(raw.box),
    name: String(raw.name ?? ''),
    createdAt: Number(raw.createdAt) || Date.now(),
    lastLaunchedAt: Number(raw.lastLaunchedAt) || Date.now(),
    fingerprint: {
      timezone: String(fp.timezone ?? ''),
      language: String(fp.language ?? ''),
      locale: String(fp.locale ?? ''),
      proxy: String(fp.proxy ?? ''),
      hostname: String(fp.hostname ?? ''),
      userAgent: String(fp.userAgent ?? ''),
      platform: String(fp.platform ?? ''),
      hardwareConcurrency: Number(fp.hardwareConcurrency) || 0,
      deviceMemory: Number(fp.deviceMemory) || 0,
      screenWidth: Number(fp.screenWidth) || 0,
      screenHeight: Number(fp.screenHeight) || 0,
      colorDepth: Number(fp.colorDepth) || 0,
      webglVendor: String(fp.webglVendor ?? ''),
      webglRenderer: String(fp.webglRenderer ?? ''),
      canvasSeed: Number(fp.canvasSeed) || 0,
      audioSeed: Number(fp.audioSeed) || 0,
      machineGuid: String(fp.machineGuid ?? ''),
      hardwareBrand: String(fp.hardwareBrand ?? ''),
      hardwareCPU: String(fp.hardwareCPU ?? ''),
      hardwareModel: String(fp.hardwareModel ?? ''),
    },
    pendingClearData: !!raw.pendingClearData,
  }
}

function normalizeConfig(raw: any): AppConfig {
  return {
    port: raw?.port ?? DEFAULT_CONFIG.port,
    profiles: Array.isArray(raw?.profiles) ? raw.profiles.map(normalizeProfile).filter(Boolean) as Profile[] : [],
    instances: Array.isArray(raw?.instances) ? raw.instances.map(normalizeInstance).filter(Boolean) as InstanceRecord[] : [],
  }
}
