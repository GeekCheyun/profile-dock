import test from 'node:test'
import assert from 'node:assert/strict'
import { assertLaunchAllowed, createLocalLicenseDocument, evaluateLicense, readLocalLicenseFromEnv } from '../server/license.js'

test('未配置商业授权时只返回本地未配置状态', () => {
  const snapshot = evaluateLicense(null, 1000, false)
  assert.equal(snapshot.state, 'unconfigured')
  assert.equal(snapshot.source, 'none')
  assert.equal(snapshot.gateEnforced, false)
})

test('本地模拟许可证覆盖有效、宽限和过期状态', () => {
  const active = evaluateLicense(createLocalLicenseDocument({ expiresAt: 2000, graceUntil: 3000 }), 1500, true)
  const grace = evaluateLicense(createLocalLicenseDocument({ expiresAt: 2000, graceUntil: 3000 }), 2500, true)
  const expired = evaluateLicense(createLocalLicenseDocument({ expiresAt: 2000, graceUntil: 3000 }), 3500, true)
  assert.equal(active.state, 'active')
  assert.equal(grace.state, 'grace')
  assert.equal(expired.state, 'expired')
})

test('许可证门禁拒绝未配置状态并限制实例数量', () => {
  assert.throws(() => assertLaunchAllowed(evaluateLicense(null, 1000, true), 1), /许可证门禁拒绝启动/)
  const snapshot = evaluateLicense(createLocalLicenseDocument({ maxInstances: 2 }), 1000, true)
  assert.doesNotThrow(() => assertLaunchAllowed(snapshot, 2))
  assert.throws(() => assertLaunchAllowed(snapshot, 3), /最多允许 2 个实例/)
})

test('环境变量只在显式 local-simulator 模式读取且不保存凭据', () => {
  const ignored = readLocalLicenseFromEnv({ MULTIOPEN_LICENSE_PLAN: 'standard' })
  const parsed = readLocalLicenseFromEnv({
    MULTIOPEN_LICENSE_MODE: 'local-simulator',
    MULTIOPEN_LICENSE_PLAN: 'standard',
    MULTIOPEN_LICENSE_MAX_INSTANCES: '5',
  })
  assert.equal(ignored, null)
  assert.equal(parsed?.plan, 'standard')
  assert.equal(parsed?.maxInstances, 5)
  assert.equal(JSON.stringify(parsed).includes('token'), false)
})
