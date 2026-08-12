import path from 'node:path'

export const INSTANCE_PRIVATE_DIRS = [
  'config',
  'browser-profile-v2',
  'appdata',
  'appdata\\Roaming',
  'appdata\\Local',
  'appdata\\Temp',
  'userdata',
  'temp',
  'runtime',
  'logs',
  'shared',
] as const

function safeProfileId(profileId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(profileId)
}

export function isWithinRoot(root: string, target: string, allowRoot = false): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget === resolvedRoot) return allowRoot
  const relative = path.relative(resolvedRoot, resolvedTarget)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function resolveProfileRoot(instancesRoot: string, profileId: string): string | null {
  if (!safeProfileId(profileId)) return null
  const candidate = path.join(path.resolve(instancesRoot), profileId)
  return isWithinRoot(instancesRoot, candidate) ? candidate : null
}

export function resolveInstanceRoot(instancesRoot: string, profileId: string, index: number): string | null {
  if (!Number.isInteger(index) || index < 1 || index > 1000000) return null
  const profileRoot = resolveProfileRoot(instancesRoot, profileId)
  if (!profileRoot) return null
  const candidate = path.join(profileRoot, String(index))
  return isWithinRoot(instancesRoot, candidate) ? candidate : null
}

export function instanceLayout(instanceRoot: string): Record<(typeof INSTANCE_PRIVATE_DIRS)[number], string> {
  const resolved = path.resolve(instanceRoot)
  return Object.fromEntries(INSTANCE_PRIVATE_DIRS.map((relative) => [relative, path.join(resolved, relative)])) as Record<(typeof INSTANCE_PRIVATE_DIRS)[number], string>
}
