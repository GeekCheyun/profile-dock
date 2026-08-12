/**
 * 商用稳定路径策略。
 *
 * 这些开关只用于显式诊断/兼容实验，默认全部关闭。Profile 配置中保留的
 * 历史 fingerprint 字段不等于它们会在稳定启动路径中被应用。
 */
export const RUNTIME_FLAGS = {
  browserHooks: 'MULTIOPEN_ENABLE_BROWSER_HOOKS',
  nativeHooks: 'MULTIOPEN_ENABLE_NATIVE_HOOKS',
  legacyFingerprint: 'MULTIOPEN_ENABLE_LEGACY_FINGERPRINT',
} as const

function enabled(name: string): boolean {
  return process.env[name] === '1'
}

/** 仅允许显式开启的浏览器外链兼容 Hook。 */
export function isBrowserHookEnabled(): boolean {
  return enabled(RUNTIME_FLAGS.browserHooks)
}

/** 仅允许显式开启的原生 Hook 兼容实验。 */
export function isNativeHookEnabled(): boolean {
  return enabled(RUNTIME_FLAGS.nativeHooks)
}

/** 旧版设备身份/代理/浏览器指纹注入路径，仅限诊断实验。 */
export function isLegacyFingerprintEnabled(): boolean {
  return enabled(RUNTIME_FLAGS.legacyFingerprint)
}

export function getRuntimePolicy(): {
  browserHooks: boolean
  nativeHooks: boolean
  legacyFingerprint: boolean
} {
  return {
    browserHooks: isBrowserHookEnabled(),
    nativeHooks: isNativeHookEnabled(),
    legacyFingerprint: isLegacyFingerprintEnabled(),
  }
}
