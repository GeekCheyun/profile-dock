import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateFingerprint,
  generateRandomFingerprint,
  defaultFingerprintConfig,
  fingerprintToEnvVars,
} from '../server/fingerprint.js'
import type { FingerprintConfig } from '../server/types.js'

const baseConfig: FingerprintConfig = {
  enabled: true,
  proxyList: [],
  timezonePool: [],
  languagePool: [],
  generateHostname: true,
  customUserAgent: '',
  region: 'mixed',
}

// ==================== 确定性指纹 ====================

test('相同 config + index 产生相同指纹', () => {
  const a = generateFingerprint(baseConfig, 1)
  const b = generateFingerprint(baseConfig, 1)
  assert.equal(a.timezone, b.timezone)
  assert.equal(a.language, b.language)
  assert.equal(a.hardwareConcurrency, b.hardwareConcurrency)
  assert.equal(a.deviceMemory, b.deviceMemory)
  assert.equal(a.screenWidth, b.screenWidth)
  assert.equal(a.screenHeight, b.screenHeight)
  assert.equal(a.webglVendor, b.webglVendor)
  assert.equal(a.webglRenderer, b.webglRenderer)
  assert.equal(a.canvasSeed, b.canvasSeed)
  assert.equal(a.audioSeed, b.audioSeed)
  assert.equal(a.hardwareBrand, b.hardwareBrand)
  assert.equal(a.hardwareCPU, b.hardwareCPU)
  assert.equal(a.hardwareModel, b.hardwareModel)
})

test('不同 index 产生不同的指纹', () => {
  const fp1 = generateFingerprint(baseConfig, 1)
  const fp2 = generateFingerprint(baseConfig, 2)
  const fp3 = generateFingerprint(baseConfig, 3)

  // 时区不同
  assert.notEqual(fp1.timezone, fp2.timezone)
  assert.notEqual(fp2.timezone, fp3.timezone)
  assert.notEqual(fp1.timezone, fp3.timezone)

  // 语言不同
  assert.notEqual(fp1.language, fp2.language)
  assert.notEqual(fp2.language, fp3.language)

  // Canvas/Audio 种子不同
  assert.notEqual(fp1.canvasSeed, fp2.canvasSeed)
  assert.notEqual(fp1.audioSeed, fp2.audioSeed)

  // MachineGuid 不同
  assert.notEqual(fp1.machineGuid, fp2.machineGuid)
})

// ==================== 禁用状态 ====================

test('enabled=false 时返回空指纹', () => {
  const disabledConfig: FingerprintConfig = { ...baseConfig, enabled: false }
  const fp = generateFingerprint(disabledConfig, 1)

  assert.equal(fp.timezone, '')
  assert.equal(fp.language, '')
  assert.equal(fp.proxy, '')
  assert.equal(fp.hostname, '')
  assert.equal(fp.userAgent, '')
  assert.equal(fp.platform, '')
  assert.equal(fp.hardwareConcurrency, 0)
  assert.equal(fp.deviceMemory, 0)
  assert.equal(fp.screenWidth, 0)
  assert.equal(fp.screenHeight, 0)
  assert.equal(fp.colorDepth, 0)
  assert.equal(fp.webglVendor, '')
  assert.equal(fp.webglRenderer, '')
  assert.equal(fp.canvasSeed, 0)
  assert.equal(fp.audioSeed, 0)
  assert.equal(fp.machineGuid, '')
  assert.equal(fp.hardwareBrand, '')
  assert.equal(fp.hardwareCPU, '')
  assert.equal(fp.hardwareModel, '')
})

// ==================== 区域池选择 ====================

test('region=domestic 仅使用亚洲时区', () => {
  const domesticConfig: FingerprintConfig = { ...baseConfig, region: 'domestic' }
  const asiaTZs = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Urumqi', 'Asia/Chongqing',
    'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kuala_Lumpur',
    'Asia/Manila', 'Asia/Jakarta', 'Asia/Ho_Chi_Minh', 'Asia/Kolkata', 'Asia/Karachi',
    'Asia/Dhaka', 'Asia/Dubai', 'Asia/Riyadh']

  for (let i = 1; i <= 10; i++) {
    const fp = generateFingerprint(domesticConfig, i)
    assert.ok(asiaTZs.some((tz) => fp.timezone === tz), `实例 ${i} 时区 ${fp.timezone} 不在亚洲池中`)
  }
})

test('region=international 仅使用欧美/大洋洲/非洲时区', () => {
  const intlConfig: FingerprintConfig = { ...baseConfig, region: 'international' }
  const nonAsiaTZs = ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver',
    'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
    'America/Buenos_Aires', 'America/Santiago', 'Europe/London', 'Europe/Berlin',
    'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm',
    'Europe/Moscow', 'Europe/Istanbul', 'Europe/Warsaw', 'Europe/Athens',
    'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland',
    'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Nairobi',
    'Pacific/Honolulu', 'America/Anchorage']

  for (let i = 1; i <= 10; i++) {
    const fp = generateFingerprint(intlConfig, i)
    assert.ok(nonAsiaTZs.some((tz) => fp.timezone === tz), `实例 ${i} 时区 ${fp.timezone} 不在国际池中`)
  }
})

// ==================== 用户自定义池 ====================

test('用户自定义时区池优先于内置池', () => {
  const customConfig: FingerprintConfig = {
    ...baseConfig,
    timezonePool: ['Asia/Shanghai', 'Asia/Tokyo'],
    region: 'international', // 即使 region 是 international，自定义池也优先
  }

  for (let i = 1; i <= 6; i++) {
    const fp = generateFingerprint(customConfig, i)
    assert.ok(fp.timezone === 'Asia/Shanghai' || fp.timezone === 'Asia/Tokyo',
      `实例 ${i} 时区 ${fp.timezone} 不在自定义池中`)
  }
})

test('自定义代理池按 index 分配', () => {
  const proxyConfig: FingerprintConfig = {
    ...baseConfig,
    proxyList: ['http://proxy1.test:8080', 'http://proxy2.test:8080', 'http://proxy3.test:8080'],
  }

  assert.equal(generateFingerprint(proxyConfig, 1).proxy, 'http://proxy1.test:8080')
  assert.equal(generateFingerprint(proxyConfig, 2).proxy, 'http://proxy2.test:8080')
  assert.equal(generateFingerprint(proxyConfig, 3).proxy, 'http://proxy3.test:8080')
  // 不足时循环复用
  assert.equal(generateFingerprint(proxyConfig, 4).proxy, 'http://proxy1.test:8080')
})

// ==================== MachineGuid 格式 ====================

test('MachineGuid 格式为 8-4-4-4-12 大写十六进制', () => {
  const fp = generateFingerprint(baseConfig, 1)
  const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/
  assert.match(fp.machineGuid, guidRegex)
})

test('generateRandomFingerprint 的 MachineGuid 格式正确', () => {
  const fp = generateRandomFingerprint(baseConfig)
  const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/
  assert.match(fp.machineGuid, guidRegex)
})

// ==================== 主机名格式 ====================

test('generateHostname=true 时生成格式为 PREFIX-XXXXXN 的主机名', () => {
  const fp = generateFingerprint(baseConfig, 1)
  const hostnameRegex = /^(DESKTOP|LAPTOP|PC|WORKSTATION|SURFACE|W10|WIN|OFFICE|HOME|STUDIO)-[A-Z0-9]{5}\d$/
  assert.match(fp.hostname, hostnameRegex)
})

test('generateHostname=false 时主机名为空', () => {
  const noHostConfig: FingerprintConfig = { ...baseConfig, generateHostname: false }
  const fp = generateFingerprint(noHostConfig, 1)
  assert.equal(fp.hostname, '')
})

// ==================== 随机指纹 ====================

test('generateRandomFingerprint 每次调用产生不同指纹', () => {
  const fp1 = generateRandomFingerprint(baseConfig)
  const fp2 = generateRandomFingerprint(baseConfig)

  // 至少有一个维度不同（随机生成，极小概率完全相同）
  const anyDiff = fp1.machineGuid !== fp2.machineGuid
    || fp1.canvasSeed !== fp2.canvasSeed
    || fp1.audioSeed !== fp2.audioSeed
    || fp1.timezone !== fp2.timezone
  assert.ok(anyDiff, '随机指纹应产生不同的值')
})

test('generateRandomFingerprint disabled 时返回空指纹', () => {
  const disabledConfig: FingerprintConfig = { ...baseConfig, enabled: false }
  const fp = generateRandomFingerprint(disabledConfig)
  assert.equal(fp.machineGuid, '')
  assert.equal(fp.timezone, '')
})

// ==================== 硬件信息隔离 ====================

test('每个实例分配不同的硬件型号', () => {
  const fp1 = generateFingerprint(baseConfig, 1)
  const fp2 = generateFingerprint(baseConfig, 2)
  const fp3 = generateFingerprint(baseConfig, 3)

  // 品牌可以重复（同一品牌有多个型号），但型号必须不同
  assert.notEqual(fp1.hardwareModel, fp2.hardwareModel)
  assert.notEqual(fp2.hardwareModel, fp3.hardwareModel)
  assert.notEqual(fp1.hardwareModel, fp3.hardwareModel)
  // CPU 也必须不同
  assert.notEqual(fp1.hardwareCPU, fp2.hardwareCPU)
  assert.notEqual(fp2.hardwareCPU, fp3.hardwareCPU)
})

test('硬件信息字段非空', () => {
  const fp = generateFingerprint(baseConfig, 1)
  assert.ok(fp.hardwareBrand.length > 0)
  assert.ok(fp.hardwareCPU.length > 0)
  assert.ok(fp.hardwareModel.length > 0)
})

// ==================== 浏览器层指纹 ====================

test('浏览器层指纹字段非空/非零', () => {
  const fp = generateFingerprint(baseConfig, 1)

  assert.ok(fp.hardwareConcurrency > 0)
  assert.ok(fp.deviceMemory > 0)
  assert.ok(fp.screenWidth > 0)
  assert.ok(fp.screenHeight > 0)
  assert.equal(fp.colorDepth, 24)
  assert.equal(fp.platform, 'Win32')
  assert.ok(fp.webglVendor.length > 0)
  assert.ok(fp.webglRenderer.length > 0)
  assert.ok(fp.userAgent.length > 0)
})

test('Canvas/Audio 种子为正数', () => {
  const fp = generateFingerprint(baseConfig, 1)
  assert.ok(fp.canvasSeed > 0)
  assert.ok(fp.audioSeed > 0)
})

// ==================== 环境变量转换 ====================

test('fingerprintToEnvVars 包含所有关键字段', () => {
  const fp = generateFingerprint(baseConfig, 1)
  const env = fingerprintToEnvVars(fp)

  assert.ok(env.TZ)
  assert.equal(env.TZ, fp.timezone)
  assert.equal(env.MULTIOPEN_TZ, fp.timezone)
  assert.ok(env.LANG)
  assert.equal(env.LANG, fp.language)
  assert.equal(env.MULTIOPEN_HOSTNAME, fp.hostname)
  assert.equal(env.MULTIOPEN_MACHINE_GUID, fp.machineGuid)
  assert.equal(env.MULTIOPEN_DEVICE_BRAND, fp.hardwareBrand)
  assert.equal(env.MULTIOPEN_DEVICE_CPU, fp.hardwareCPU)
  assert.equal(env.MULTIOPEN_DEVICE_MODEL, fp.hardwareModel)
  assert.equal(env.MULTIOPEN_USER_AGENT, fp.userAgent)
})

test('fingerprintToEnvVars 空指纹不产生多余键', () => {
  const emptyFp = generateFingerprint({ ...baseConfig, enabled: false }, 1)
  const env = fingerprintToEnvVars(emptyFp)
  assert.equal(Object.keys(env).length, 0)
})

test('有代理时 env 包含代理相关变量', () => {
  const proxyConfig: FingerprintConfig = {
    ...baseConfig,
    proxyList: ['http://proxy.test:8080'],
  }
  const fp = generateFingerprint(proxyConfig, 1)
  const env = fingerprintToEnvVars(fp)

  assert.equal(env.HTTP_PROXY, 'http://proxy.test:8080')
  assert.equal(env.HTTPS_PROXY, 'http://proxy.test:8080')
  assert.equal(env.TTNET_QUIC_DISABLE, '1')
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1')
})

test('fingerprintToEnvVars 无代理时不包含代理变量', () => {
  const noProxyConfig: FingerprintConfig = { ...baseConfig, proxyList: [] }
  const fp = generateFingerprint(noProxyConfig, 1)
  const env = fingerprintToEnvVars(fp)

  assert.equal(env.HTTP_PROXY, undefined)
  assert.equal(env.HTTPS_PROXY, undefined)
})

// ==================== 自定义 UA ====================

test('customUserAgent 优先于内置 UA 池', () => {
  const customUaConfig: FingerprintConfig = {
    ...baseConfig,
    customUserAgent: 'Mozilla/5.0 (Custom) TestAgent/1.0',
  }

  for (let i = 1; i <= 5; i++) {
    const fp = generateFingerprint(customUaConfig, i)
    assert.equal(fp.userAgent, 'Mozilla/5.0 (Custom) TestAgent/1.0')
  }
})

// ==================== 默认配置 ====================

test('defaultFingerprintConfig 返回未启用的配置', () => {
  const config = defaultFingerprintConfig()
  assert.equal(config.enabled, false)
  assert.equal(config.region, 'mixed')
  assert.equal(config.generateHostname, true)
  assert.equal(config.customUserAgent, '')
  assert.deepEqual(config.proxyList, [])
  assert.deepEqual(config.timezonePool, [])
  assert.deepEqual(config.languagePool, [])
})

// ==================== 50 实例不重复测试 ====================

test('连续 50 个实例时区不重复', () => {
  const timezones = new Set<string>()
  for (let i = 1; i <= 50; i++) {
    const fp = generateFingerprint(baseConfig, i)
    assert.ok(!timezones.has(fp.timezone), `实例 ${i} 时区 ${fp.timezone} 重复`)
    timezones.add(fp.timezone)
  }
  assert.equal(timezones.size, 50)
})

test('连续 50 个实例语言使用内置池（可能有重复，语言池天然存在重复）', () => {
  const languages = new Set<string>()
  for (let i = 1; i <= 50; i++) {
    const fp = generateFingerprint(baseConfig, i)
    languages.add(fp.language)
  }
  // 内置语言池有重复值（如 en-US 出现多次），公平断言唯一值数量
  assert.ok(languages.size >= 30, `期望至少 30 种语言，实际 ${languages.size}`)
  assert.ok(languages.size <= 50, `期望不超过 50 种语言，实际 ${languages.size}`)
})