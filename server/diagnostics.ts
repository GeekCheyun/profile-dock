import path from 'node:path'
import type { InstanceState } from './types.js'
import { ROOT } from './util.js'
import { getRuntimePolicy } from './runtime-policy.js'
import { isWithinRoot } from './instance-layout.js'

export interface DiagnosticReport {
  schemaVersion: 1
  generatedAt: string
  runtime: { node: string; electron: string | null; policy: ReturnType<typeof getRuntimePolicy> }
  instance: {
    profileId: string
    index: number
    box: string
    state: InstanceState | 'unknown'
    running: boolean
    pidCount: number
    paths: { workDir: string; configDir: string; browserProfileDir: string }
    egress: 'configured-unverified' | 'not-configured'
  }
  restrictions: string[]
}

function redactManagedPath(workDir: string): string {
  const root = path.join(ROOT, 'engine', 'instances')
  const resolved = path.resolve(workDir)
  if (!isWithinRoot(root, resolved)) return '<unmanaged>'
  const relative = path.relative(root, resolved).split(path.sep).join('/')
  return `<instances>/${relative}`
}

export function createDiagnosticReport(input: {
  profileId: string
  index: number
  box: string
  workDir: string
  state?: InstanceState
  running: boolean
  pidCount: number
  egressConfigured?: boolean
}): DiagnosticReport {
  const workDir = redactManagedPath(input.workDir)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron || null,
      policy: getRuntimePolicy(),
    },
    instance: {
      profileId: input.profileId,
      index: input.index,
      box: input.box,
      state: input.state || 'unknown',
      running: input.running,
      pidCount: input.pidCount,
      paths: {
        workDir,
        configDir: `${workDir}/config`,
        browserProfileDir: `${workDir}/browser-profile-v2`,
      },
      egress: input.egressConfigured ? 'configured-unverified' : 'not-configured',
    },
    restrictions: [
      '本报告不证明目标应用的服务端登录、签到、设备识别或平台风控结果。',
      '可信出口即使配置成功，也需要实例内实际流量验证后才能标记 egress_verified。',
      '本报告不包含授权 URL、Cookie、Token、PKCE、代理密码或用户内容。',
    ],
  }
}
