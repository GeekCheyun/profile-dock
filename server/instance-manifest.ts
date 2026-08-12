import type { InstanceState } from './types.js'

export const INSTANCE_MANIFEST_SCHEMA_VERSION = 1 as const

export interface InstanceManifest {
  schemaVersion: typeof INSTANCE_MANIFEST_SCHEMA_VERSION
  instanceId: string
  profileId: string
  index: number
  boxName: string
  workDir: string
  configDir: string
  browserProfileDir: string
  state: InstanceState
  pid: number
  createdAt: number
  lastStateAt: number
  lastLaunchedAt: number
  lastError?: { code: string; message: string }
}

const transitions: Record<InstanceState, readonly InstanceState[]> = {
  created: ['preparing', 'failed'],
  preparing: ['starting', 'failed', 'quarantined'],
  starting: ['process_ready', 'preparing', 'failed', 'stopping', 'quarantined'],
  process_ready: ['egress_verified', 'browser_verified', 'ready', 'preparing', 'stopping', 'failed', 'quarantined'],
  egress_verified: ['browser_verified', 'ready', 'preparing', 'stopping', 'failed', 'quarantined'],
  browser_verified: ['ready', 'preparing', 'stopping', 'failed', 'quarantined'],
  ready: ['preparing', 'stopping', 'failed', 'quarantined'],
  stopping: ['stopped', 'preparing', 'failed'],
  stopped: ['preparing', 'failed'],
  failed: ['preparing', 'stopped', 'quarantined'],
  quarantined: ['preparing', 'stopped'],
}

export function canTransition(from: InstanceState, to: InstanceState): boolean {
  return transitions[from].includes(to)
}

export function createInstanceManifest(input: {
  profileId: string
  index: number
  boxName: string
  workDir: string
  now?: number
}): InstanceManifest {
  const now = input.now ?? Date.now()
  return {
    schemaVersion: INSTANCE_MANIFEST_SCHEMA_VERSION,
    instanceId: `${input.profileId}:${input.index}`,
    profileId: input.profileId,
    index: input.index,
    boxName: input.boxName,
    workDir: input.workDir,
    configDir: `${input.workDir}\\config`,
    browserProfileDir: `${input.workDir}\\browser-profile-v2`,
    state: 'created',
    pid: 0,
    createdAt: now,
    lastStateAt: now,
    lastLaunchedAt: 0,
  }
}

export function transitionInstanceState(
  manifest: InstanceManifest,
  next: InstanceState,
  options: { now?: number; pid?: number; error?: { code: string; message: string } } = {},
): InstanceManifest {
  if (!canTransition(manifest.state, next)) {
    throw new Error(`非法实例状态迁移: ${manifest.state} -> ${next}`)
  }
  const now = options.now ?? Date.now()
  const nextManifest: InstanceManifest = {
    ...manifest,
    state: next,
    lastStateAt: now,
    pid: options.pid ?? manifest.pid,
  }
  if (next === 'starting') nextManifest.lastLaunchedAt = now
  if (next === 'stopped') nextManifest.pid = 0
  if (options.error) nextManifest.lastError = options.error
  else if (next !== 'failed' && next !== 'quarantined') delete nextManifest.lastError
  return nextManifest
}
