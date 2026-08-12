import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { getRuntimePolicy, isBrowserHookEnabled, isLegacyFingerprintEnabled, isNativeHookEnabled } from '../server/runtime-policy.js'

const FLAG_NAMES = [
  'MULTIOPEN_ENABLE_BROWSER_HOOKS',
  'MULTIOPEN_ENABLE_NATIVE_HOOKS',
  'MULTIOPEN_ENABLE_LEGACY_FINGERPRINT',
] as const

test('稳定路径默认关闭 native/browser Hook 和旧版指纹路径', () => {
  const previous = Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]))
  try {
    for (const name of FLAG_NAMES) delete process.env[name]
    assert.deepEqual(getRuntimePolicy(), { browserHooks: false, nativeHooks: false, legacyFingerprint: false })
    assert.equal(isBrowserHookEnabled(), false)
    assert.equal(isNativeHookEnabled(), false)
    assert.equal(isLegacyFingerprintEnabled(), false)
  } finally {
    for (const name of FLAG_NAMES) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('策略开关必须精确等于 1 才能启用', () => {
  const previous = Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name]]))
  try {
    process.env.MULTIOPEN_ENABLE_BROWSER_HOOKS = 'true'
    process.env.MULTIOPEN_ENABLE_NATIVE_HOOKS = 'yes'
    process.env.MULTIOPEN_ENABLE_LEGACY_FINGERPRINT = '0'
    assert.deepEqual(getRuntimePolicy(), { browserHooks: false, nativeHooks: false, legacyFingerprint: false })
    process.env.MULTIOPEN_ENABLE_BROWSER_HOOKS = '1'
    process.env.MULTIOPEN_ENABLE_NATIVE_HOOKS = '1'
    process.env.MULTIOPEN_ENABLE_LEGACY_FINGERPRINT = '1'
    assert.deepEqual(getRuntimePolicy(), { browserHooks: true, nativeHooks: true, legacyFingerprint: true })
  } finally {
    for (const name of FLAG_NAMES) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('稳定路径不再包含不安全 TLS 降级赋值', () => {
  const source = readFileSync(new URL('../server/engine.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /NODE_TLS_REJECT_UNAUTHORIZED\s*=/)
})
