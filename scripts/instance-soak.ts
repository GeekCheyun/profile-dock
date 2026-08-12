import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInstanceManifest, transitionInstanceState } from '../server/instance-manifest.js'
import { instanceLayout, resolveInstanceRoot } from '../server/instance-layout.js'

const requested = Number(process.argv.find((arg) => arg.startsWith('--iterations='))?.split('=')[1] || 100)
const iterations = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 10000)) : 100
let faultInjections = 0
let completed = 0
const startedAt = Date.now()

for (let iteration = 1; iteration <= iterations; iteration++) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'multiopen-instance-soak-'))
  try {
    const roots = []
    for (const index of [1, 2, 3]) {
      const instanceRoot = resolveInstanceRoot(root, 'soak-profile', index)
      if (!instanceRoot) throw new Error(`实例路径解析失败: ${index}`)
      const layout = instanceLayout(instanceRoot)
      for (const directory of Object.values(layout)) mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(layout.runtime, 'iteration.txt'), `${iteration}:${index}`, 'utf8')
      let manifest = createInstanceManifest({ profileId: 'soak-profile', index, boxName: `Soak-${index}`, workDir: instanceRoot, now: iteration })
      manifest = transitionInstanceState(manifest, 'preparing', { now: iteration + 1 })
      manifest = transitionInstanceState(manifest, 'starting', { now: iteration + 2 })
      if (iteration % 5 === 0 && index === 2) {
        manifest = transitionInstanceState(manifest, 'failed', { now: iteration + 3, error: { code: 'SOAK_INJECTED_FAILURE', message: 'bounded test fault' } })
        manifest = transitionInstanceState(manifest, 'preparing', { now: iteration + 4 })
        manifest = transitionInstanceState(manifest, 'starting', { now: iteration + 5 })
        faultInjections++
      }
      manifest = transitionInstanceState(manifest, 'process_ready', { now: iteration + 6, pid: 20000 + index })
      manifest = transitionInstanceState(manifest, 'egress_verified', { now: iteration + 7 })
      manifest = transitionInstanceState(manifest, 'browser_verified', { now: iteration + 8 })
      manifest = transitionInstanceState(manifest, 'ready', { now: iteration + 9 })
      manifest = transitionInstanceState(manifest, 'stopping', { now: iteration + 10 })
      manifest = transitionInstanceState(manifest, 'stopped', { now: iteration + 11 })
      if (manifest.state !== 'stopped' || manifest.pid !== 0) throw new Error(`实例恢复状态错误: ${index}`)
      roots.push(instanceRoot)
    }
    if (new Set(roots).size !== 3) throw new Error('实例根目录发生重叠')
    completed++
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({ ok: completed === iterations, iterations, completed, faultInjections, elapsedMs: Date.now() - startedAt }, null, 2))
