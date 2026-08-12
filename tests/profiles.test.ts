import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Store 使用 MULTIOPEN_DATA_DIR 确定配置文件路径，测试需隔离到临时目录
let tempDir: string
let sandboxedStore: typeof import('../server/profiles.js')

test.before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-profiles-'))
  process.env.MULTIOPEN_DATA_DIR = tempDir
  // 动态导入确保 Store 使用 tempDir 下的 config.json
  sandboxedStore = await import('../server/profiles.js')
})

test.after(() => {
  assert.ok(tempDir.startsWith(os.tmpdir()))
  rmSync(tempDir, { recursive: true, force: true })
  delete process.env.MULTIOPEN_DATA_DIR
})

// ==================== 档案 CRUD ====================

test('创建档案并获取', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '测试档案',
    appPath: 'C:\\test\\app.exe',
    appArgs: '',
    workDir: '',
    boxPrefix: 'Test',
    openPaths: [],
    defaultCount: 2,
    cleanOnClose: false,
    boxNameTitle: true,
    extraIni: '',
    fingerprint: {
      enabled: false,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: false,
      customUserAgent: '',
      region: 'mixed',
    },
  })

  assert.ok(profile.id.length > 0)
  assert.equal(profile.name, '测试档案')
  assert.equal(profile.boxPrefix, 'Test')

  const retrieved = store.get(profile.id)
  assert.ok(retrieved)
  assert.equal(retrieved!.name, '测试档案')
})

test('更新档案', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '原始名称',
    appPath: 'C:\\test\\app.exe',
    appArgs: '',
    workDir: '',
    boxPrefix: 'Orig',
    openPaths: [],
    defaultCount: 1,
    cleanOnClose: false,
    boxNameTitle: true,
    extraIni: '',
    fingerprint: {
      enabled: false,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: false,
      customUserAgent: '',
      region: 'mixed',
    },
  })

  const updated = store.update(profile.id, {
    name: '新名称',
    appPath: 'C:\\test\\app2.exe',
    appArgs: '--test',
    workDir: 'C:\\test',
    boxPrefix: 'New',
    openPaths: ['C:\\shared'],
    defaultCount: 3,
    cleanOnClose: true,
    boxNameTitle: false,
    extraIni: 'Key=Value',
    fingerprint: {
      enabled: true,
      proxyList: ['http://proxy.test:8080'],
      timezonePool: ['Asia/Shanghai'],
      languagePool: ['zh-CN'],
      generateHostname: true,
      customUserAgent: '',
      region: 'domestic',
    },
  })

  assert.ok(updated)
  assert.equal(updated!.name, '新名称')
  assert.equal(updated!.appArgs, '--test')
  assert.equal(updated!.boxPrefix, 'New')
  assert.equal(updated!.defaultCount, 3)
  assert.equal(updated!.fingerprint.enabled, true)
  assert.equal(updated!.fingerprint.region, 'domestic')
})

test('更新不存在的档案返回 null', () => {
  const store = new sandboxedStore.Store()
  const result = store.update('nonexistent-id', {
    name: 'x',
    appPath: 'x',
    appArgs: '',
    workDir: '',
    boxPrefix: 'x',
    openPaths: [],
    defaultCount: 1,
    cleanOnClose: false,
    boxNameTitle: true,
    extraIni: '',
    fingerprint: {
      enabled: false,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: false,
      customUserAgent: '',
      region: 'mixed',
    },
  })
  assert.equal(result, null)
})

test('删除档案同时清除关联实例', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '待删除',
    appPath: 'C:\\test\\app.exe',
    appArgs: '',
    workDir: '',
    boxPrefix: 'Del',
    openPaths: [],
    defaultCount: 1,
    cleanOnClose: false,
    boxNameTitle: true,
    extraIni: '',
    fingerprint: {
      enabled: false,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: false,
      customUserAgent: '',
      region: 'mixed',
    },
  })

  // 创建关联实例
  store.upsertInstance(profile, 1)
  assert.equal(store.listInstances(profile.id).length, 1)

  // 删除档案
  const removed = store.remove(profile.id)
  assert.equal(removed, true)
  assert.equal(store.get(profile.id), undefined)
  assert.equal(store.listInstances(profile.id).length, 0)
})

test('删除不存在的档案返回 false', () => {
  const store = new sandboxedStore.Store()
  assert.equal(store.remove('nonexistent'), false)
})

test('boxName 生成正确的沙箱名', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: 'test',
    appPath: 'C:\\test\\app.exe',
    appArgs: '',
    workDir: '',
    boxPrefix: 'MyApp',
    openPaths: [],
    defaultCount: 1,
    cleanOnClose: false,
    boxNameTitle: true,
    extraIni: '',
    fingerprint: {
      enabled: false,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: false,
      customUserAgent: '',
      region: 'mixed',
    },
  })

  assert.equal(store.boxName(profile, 1), 'MyApp-1')
  assert.equal(store.boxName(profile, 5), 'MyApp-5')
})

// ==================== 实例管理 ====================

test('upsertInstance 创建新实例', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '实例测试',
    appPath: 'C:\\test\\app.exe',
    appArgs: '',
    workDir: '',
    boxPrefix: 'Inst',
    openPaths: [],
    defaultCount: 1,
    cleanOnClose: false,
    boxNameTitle: true,
    extraIni: '',
    fingerprint: {
      enabled: false,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: false,
      customUserAgent: '',
      region: 'mixed',
    },
  })

  const record = store.upsertInstance(profile, 1)
  assert.equal(record.box, 'Inst-1')
  assert.equal(record.index, 1)
  assert.equal(record.profileId, profile.id)
  assert.ok(record.id.length > 0)
  assert.ok(record.createdAt > 0)
  assert.equal(record.lastLaunchedAt, record.createdAt)
})

test('upsertInstance 对已存在实例更新 lastLaunchedAt', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '重复实例',
    appPath: 'C:\\test\\app.exe',
    appArgs: '',
    workDir: '',
    boxPrefix: 'Dup',
    openPaths: [],
    defaultCount: 1,
    cleanOnClose: false,
    boxNameTitle: true,
    extraIni: '',
    fingerprint: {
      enabled: false,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: false,
      customUserAgent: '',
      region: 'mixed',
    },
  })

  const first = store.upsertInstance(profile, 1)
  const second = store.upsertInstance(profile, 1)

  // 同一实例，id 不变
  assert.equal(second.id, first.id)
  assert.equal(second.box, first.box)
  // createdAt 不变
  assert.equal(second.createdAt, first.createdAt)
  // lastLaunchedAt 被更新
  assert.ok(second.lastLaunchedAt >= first.lastLaunchedAt)
})

test('listInstances 按 profileId 过滤', () => {
  const store = new sandboxedStore.Store()
  const p1 = store.create({
    name: 'P1', appPath: 'C:\\a.exe', appArgs: '', workDir: '', boxPrefix: 'P1',
    openPaths: [], defaultCount: 1, cleanOnClose: false, boxNameTitle: true, extraIni: '',
    fingerprint: { enabled: false, proxyList: [], timezonePool: [], languagePool: [], generateHostname: false, customUserAgent: '', region: 'mixed' },
  })
  const p2 = store.create({
    name: 'P2', appPath: 'C:\\b.exe', appArgs: '', workDir: '', boxPrefix: 'P2',
    openPaths: [], defaultCount: 1, cleanOnClose: false, boxNameTitle: true, extraIni: '',
    fingerprint: { enabled: false, proxyList: [], timezonePool: [], languagePool: [], generateHostname: false, customUserAgent: '', region: 'mixed' },
  })

  store.upsertInstance(p1, 1)
  store.upsertInstance(p1, 2)
  store.upsertInstance(p2, 1)

  // 只验证该 profileId 的实例数量
  assert.equal(store.listInstances(p1.id).length, 2)
  assert.equal(store.listInstances(p2.id).length, 1)
  // listAllInstances 可能包含其他测试遗留的实例，只验证至少包含我们创建的
  assert.ok(store.listAllInstances().length >= 3)
})

test('findInstanceByBox 按 box 名查找', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '查找测试', appPath: 'C:\\test\\app.exe', appArgs: '', workDir: '', boxPrefix: 'Find',
    openPaths: [], defaultCount: 1, cleanOnClose: false, boxNameTitle: true, extraIni: '',
    fingerprint: { enabled: false, proxyList: [], timezonePool: [], languagePool: [], generateHostname: false, customUserAgent: '', region: 'mixed' },
  })

  store.upsertInstance(profile, 1)
  store.upsertInstance(profile, 2)

  const found = store.findInstanceByBox('Find-1')
  assert.ok(found)
  assert.equal(found!.index, 1)

  const notFound = store.findInstanceByBox('Find-999')
  assert.equal(notFound, undefined)
})

test('removeInstance 删除实例', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '删除实例', appPath: 'C:\\test\\app.exe', appArgs: '', workDir: '', boxPrefix: 'Rm',
    openPaths: [], defaultCount: 1, cleanOnClose: false, boxNameTitle: true, extraIni: '',
    fingerprint: { enabled: false, proxyList: [], timezonePool: [], languagePool: [], generateHostname: false, customUserAgent: '', region: 'mixed' },
  })

  store.upsertInstance(profile, 1)
  store.upsertInstance(profile, 2)
  assert.equal(store.listInstances(profile.id).length, 2)

  store.removeInstance('Rm-1')
  assert.equal(store.listInstances(profile.id).length, 1)
  assert.equal(store.listInstances(profile.id)[0].box, 'Rm-2')
})

test('removeInstance 不存在的实例返回 false', () => {
  const store = new sandboxedStore.Store()
  assert.equal(store.removeInstance('nonexistent'), false)
})

// ==================== 指纹生成 ====================

test('upsertInstance 为启用指纹的实例生成独立指纹', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '指纹实例', appPath: 'C:\\test\\app.exe', appArgs: '', workDir: '', boxPrefix: 'FP',
    openPaths: [], defaultCount: 1, cleanOnClose: false, boxNameTitle: true, extraIni: '',
    fingerprint: {
      enabled: true,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: true,
      customUserAgent: '',
      region: 'mixed',
    },
  })

  const r1 = store.upsertInstance(profile, 1)
  const r2 = store.upsertInstance(profile, 2)

  assert.ok(r1.fingerprint.machineGuid.length > 0)
  assert.ok(r2.fingerprint.machineGuid.length > 0)
  assert.notEqual(r1.fingerprint.machineGuid, r2.fingerprint.machineGuid)
  assert.notEqual(r1.fingerprint.timezone, r2.fingerprint.timezone)
  assert.notEqual(r1.fingerprint.hostname, r2.fingerprint.hostname)
})

test('upsertInstance 禁用指纹时实例指纹为空', () => {
  const store = new sandboxedStore.Store()
  const profile = store.create({
    name: '无指纹', appPath: 'C:\\test\\app.exe', appArgs: '', workDir: '', boxPrefix: 'NoFP',
    openPaths: [], defaultCount: 1, cleanOnClose: false, boxNameTitle: true, extraIni: '',
    fingerprint: {
      enabled: false,
      proxyList: [],
      timezonePool: [],
      languagePool: [],
      generateHostname: false,
      customUserAgent: '',
      region: 'mixed',
    },
  })

  const record = store.upsertInstance(profile, 1)
  assert.equal(record.fingerprint.machineGuid, '')
  assert.equal(record.fingerprint.timezone, '')
})

// ==================== 引擎状态 ====================

test('getEngineStatus 返回引擎状态', () => {
  const store = new sandboxedStore.Store()
  const status = store.getEngineStatus()
  assert.equal(status.ready, true)
  assert.equal(status.version, '1.0.0')
})