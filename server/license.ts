import crypto from 'node:crypto'

export type LicenseState = 'unconfigured' | 'active' | 'grace' | 'expired' | 'invalid'
export type LicensePlan = 'none' | 'trial' | 'standard' | 'enterprise'

export interface LicenseFeatures {
  multiInstance: boolean
  trustedEgress: boolean
  diagnostics: boolean
  backupRestore: boolean
}

export interface LocalLicenseDocument {
  schemaVersion: 1
  mode: 'local-simulator'
  licenseId: string
  plan: LicensePlan
  expiresAt?: number
  graceUntil?: number
  maxInstances: number
  features: LicenseFeatures
}

export interface LicenseSnapshot {
  state: LicenseState
  source: 'none' | 'local-simulator'
  plan: LicensePlan
  licenseId?: string
  expiresAt?: number
  graceUntil?: number
  maxInstances: number
  features: LicenseFeatures
  gateEnforced: boolean
  reason: string
}

const EMPTY_FEATURES: LicenseFeatures = {
  multiInstance: false,
  trustedEgress: false,
  diagnostics: false,
  backupRestore: false,
}

function cloneFeatures(features: LicenseFeatures): LicenseFeatures {
  return { ...features }
}

function invalidSnapshot(reason: string, gateEnforced: boolean): LicenseSnapshot {
  return {
    state: 'invalid',
    source: 'local-simulator',
    plan: 'none',
    maxInstances: 0,
    features: cloneFeatures(EMPTY_FEATURES),
    gateEnforced,
    reason,
  }
}

export function createLocalLicenseDocument(input: {
  plan?: Exclude<LicensePlan, 'none'>
  expiresAt?: number
  graceUntil?: number
  maxInstances?: number
  features?: Partial<LicenseFeatures>
} = {}): LocalLicenseDocument {
  return {
    schemaVersion: 1,
    mode: 'local-simulator',
    licenseId: `local-${crypto.randomUUID()}`,
    plan: input.plan ?? 'trial',
    expiresAt: input.expiresAt,
    graceUntil: input.graceUntil,
    maxInstances: Math.max(1, Math.min(1000, Math.floor(input.maxInstances ?? 3))),
    features: {
      multiInstance: input.features?.multiInstance ?? true,
      trustedEgress: input.features?.trustedEgress ?? true,
      diagnostics: input.features?.diagnostics ?? true,
      backupRestore: input.features?.backupRestore ?? true,
    },
  }
}

export function evaluateLicense(
  document: LocalLicenseDocument | null | undefined,
  now = Date.now(),
  gateEnforced = isLicenseGateEnabled(),
): LicenseSnapshot {
  if (!document) {
    return {
      state: 'unconfigured',
      source: 'none',
      plan: 'none',
      maxInstances: 0,
      features: cloneFeatures(EMPTY_FEATURES),
      gateEnforced,
      reason: '未接入商业授权服务；当前仅提供本地模拟器接口',
    }
  }
  if (document.schemaVersion !== 1 || document.mode !== 'local-simulator') {
    return invalidSnapshot('许可证格式或来源不受支持', gateEnforced)
  }
  if (!Number.isFinite(document.maxInstances) || document.maxInstances < 1) {
    return invalidSnapshot('许可证实例上限无效', gateEnforced)
  }
  if (document.expiresAt !== undefined && (!Number.isFinite(document.expiresAt) || document.expiresAt <= 0)) {
    return invalidSnapshot('许可证到期时间无效', gateEnforced)
  }
  if (document.graceUntil !== undefined && (!Number.isFinite(document.graceUntil) || document.graceUntil <= 0)) {
    return invalidSnapshot('许可证宽限时间无效', gateEnforced)
  }

  const common = {
    source: 'local-simulator' as const,
    plan: document.plan,
    licenseId: document.licenseId,
    expiresAt: document.expiresAt,
    graceUntil: document.graceUntil,
    maxInstances: Math.floor(document.maxInstances),
    features: cloneFeatures(document.features),
    gateEnforced,
  }
  if (document.expiresAt !== undefined && now > document.expiresAt) {
    if (document.graceUntil !== undefined && now <= document.graceUntil) {
      return { ...common, state: 'grace', reason: '许可证已到期，当前处于离线宽限期' }
    }
    return { ...common, state: 'expired', reason: '许可证已过期且宽限期已结束' }
  }
  return { ...common, state: 'active', reason: '本地模拟许可证有效；尚未接入商业签发服务' }
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseFeatures(value: string | undefined): Partial<LicenseFeatures> {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return {
      multiInstance: parsed.multiInstance === true,
      trustedEgress: parsed.trustedEgress === true,
      diagnostics: parsed.diagnostics === true,
      backupRestore: parsed.backupRestore === true,
    }
  } catch {
    return {}
  }
}

export function readLocalLicenseFromEnv(env: NodeJS.ProcessEnv = process.env): LocalLicenseDocument | null {
  if (env.MULTIOPEN_LICENSE_MODE !== 'local-simulator') return null
  const plan = env.MULTIOPEN_LICENSE_PLAN
  if (plan !== 'trial' && plan !== 'standard' && plan !== 'enterprise') return null
  return createLocalLicenseDocument({
    plan,
    expiresAt: parseNumber(env.MULTIOPEN_LICENSE_EXPIRES_AT),
    graceUntil: parseNumber(env.MULTIOPEN_LICENSE_GRACE_UNTIL),
    maxInstances: parseNumber(env.MULTIOPEN_LICENSE_MAX_INSTANCES),
    features: parseFeatures(env.MULTIOPEN_LICENSE_FEATURES),
  })
}

export function isLicenseGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MULTIOPEN_ENABLE_LICENSE_GATE === '1'
}

export function getLicenseSnapshot(now = Date.now(), env: NodeJS.ProcessEnv = process.env): LicenseSnapshot {
  return evaluateLicense(readLocalLicenseFromEnv(env), now, isLicenseGateEnabled(env))
}

export function assertLaunchAllowed(snapshot: LicenseSnapshot, requestedInstances: number): void {
  if (!snapshot.gateEnforced) return
  if (snapshot.state !== 'active' && snapshot.state !== 'grace') {
    throw new Error(`许可证门禁拒绝启动：${snapshot.reason}`)
  }
  if (!Number.isInteger(requestedInstances) || requestedInstances < 1 || requestedInstances > snapshot.maxInstances) {
    throw new Error(`许可证门禁拒绝启动：本次最多允许 ${snapshot.maxInstances} 个实例`)
  }
  if (!snapshot.features.multiInstance) {
    throw new Error('许可证未包含多实例能力')
  }
}
