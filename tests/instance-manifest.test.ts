import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canTransition, createInstanceManifest, transitionInstanceState } from '../server/instance-manifest.js'

test('InstanceManifest 创建时包含实例私有目录和初始状态', () => {
  const manifest = createInstanceManifest({ profileId: 'p1', index: 2, boxName: 'App-2', workDir: 'D:\\instances\\p1\\2', now: 100 })
  assert.equal(manifest.instanceId, 'p1:2')
  assert.equal(manifest.state, 'created')
  assert.equal(manifest.configDir, 'D:\\instances\\p1\\2\\config')
  assert.equal(manifest.browserProfileDir, 'D:\\instances\\p1\\2\\browser-profile-v2')
})

test('InstanceManifest 正常状态链可推进并记录 PID', () => {
  let manifest = createInstanceManifest({ profileId: 'p1', index: 1, boxName: 'App-1', workDir: 'D:\\instances\\p1\\1', now: 100 })
  for (const state of ['preparing', 'starting'] as const) manifest = transitionInstanceState(manifest, state, { now: manifest.lastStateAt + 1 })
  manifest = transitionInstanceState(manifest, 'process_ready', { now: 103, pid: 456 })
  assert.equal(manifest.state, 'process_ready')
  assert.equal(manifest.pid, 456)
  manifest = transitionInstanceState(manifest, 'stopping', { now: 104 })
  manifest = transitionInstanceState(manifest, 'stopped', { now: 105 })
  assert.equal(manifest.pid, 0)
})

test('InstanceManifest 拒绝跳过启动阶段的非法迁移', () => {
  assert.equal(canTransition('created', 'ready'), false)
  const manifest = createInstanceManifest({ profileId: 'p1', index: 1, boxName: 'App-1', workDir: 'D:\\instances\\p1\\1' })
  assert.throws(() => transitionInstanceState(manifest, 'ready'), /非法实例状态迁移/)
})
