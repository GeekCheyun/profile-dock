import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInstanceManifest, transitionInstanceState } from '../server/instance-manifest.js'
import { instanceLayout, resolveInstanceRoot } from '../server/instance-layout.js'

test('三个实例并发准备时目录、状态和本地内容互不重叠', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'multiopen-three-instance-'))
  try {
    const manifests = []
    const roots = []
    for (const index of [1, 2, 3]) {
      const instanceRoot = resolveInstanceRoot(root, 'profile-a', index)
      assert.ok(instanceRoot)
      const layout = instanceLayout(instanceRoot)
      for (const directory of Object.values(layout)) mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(layout.config, 'instance-only.txt'), `instance-${index}`, 'utf8')
      let manifest = createInstanceManifest({ profileId: 'profile-a', index, boxName: `App-${index}`, workDir: instanceRoot, now: index })
      manifest = transitionInstanceState(manifest, 'preparing', { now: index + 1 })
      manifest = transitionInstanceState(manifest, 'starting', { now: index + 2 })
      manifest = transitionInstanceState(manifest, 'process_ready', { now: index + 3, pid: 1000 + index })
      manifest = transitionInstanceState(manifest, 'ready', { now: index + 4, pid: 1000 + index })
      manifests.push(manifest)
      roots.push(instanceRoot)
    }
    assert.equal(new Set(roots).size, 3)
    assert.deepEqual(manifests.map((manifest) => manifest.state), ['ready', 'ready', 'ready'])
    assert.deepEqual(manifests.map((manifest) => manifest.pid), [1001, 1002, 1003])
    assert.equal(readFileSync(path.join(roots[0], 'config', 'instance-only.txt'), 'utf8'), 'instance-1')
    assert.equal(readFileSync(path.join(roots[1], 'config', 'instance-only.txt'), 'utf8'), 'instance-2')
    assert.equal(readFileSync(path.join(roots[2], 'config', 'instance-only.txt'), 'utf8'), 'instance-3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
