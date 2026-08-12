import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR, ROOT, uid, writeJsonAtomic } from './util.js'
import { resolveInstanceRoot } from './instance-layout.js'

interface BackupManifest {
  schemaVersion: 1
  backupId: string
  profileId: string
  index: number
  createdAt: string
  source: string
  excluded: string[]
}

function copySafeTree(source: string, target: string, relative = ''): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(source)) {
      if (!relative && name === 'shared') continue
      copySafeTree(path.join(source, name), path.join(target, name), path.join(relative, name))
    }
    return
  }
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(source, target)
}

function sourceInstanceRoot(profileId: string, index: number, instancesRoot = path.join(ROOT, 'engine', 'instances')): string {
  const root = resolveInstanceRoot(instancesRoot, profileId, index)
  if (!root) throw new Error('实例路径不安全')
  return root
}

export function backupInstance(profileId: string, index: number, backupRoot = path.join(DATA_DIR, 'backups'), instancesRoot = path.join(ROOT, 'engine', 'instances')): string {
  const source = sourceInstanceRoot(profileId, index, instancesRoot)
  if (!existsSync(source)) throw new Error('实例目录不存在')
  const backupId = `${profileId}-${index}-${Date.now()}-${uid().slice(0, 8)}`
  const target = path.join(path.resolve(backupRoot), backupId)
  mkdirSync(target, { recursive: true })
  copySafeTree(source, path.join(target, 'instance'))
  const manifest: BackupManifest = {
    schemaVersion: 1,
    backupId,
    profileId,
    index,
    createdAt: new Date().toISOString(),
    source: `<instances>/${profileId}/${index}`,
    excluded: ['shared (Junction/用户真实文件夹)', '凭据保护区外的系统密钥'],
  }
  writeJsonAtomic(path.join(target, 'backup-manifest.json'), manifest)
  return target
}

export function restoreInstanceBackup(backupDir: string, profileId: string, index: number, instancesRoot = path.join(ROOT, 'engine', 'instances')): string {
  const backup = path.resolve(backupDir)
  const manifestFile = path.join(backup, 'backup-manifest.json')
  const source = path.join(backup, 'instance')
  if (!existsSync(manifestFile) || !existsSync(source)) throw new Error('备份目录不完整')
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as BackupManifest
  } catch {
    throw new Error('备份目录不完整')
  }
  if (manifest.schemaVersion !== 1 || manifest.profileId !== profileId || manifest.index !== index) throw new Error('备份与目标实例不匹配')
  const target = sourceInstanceRoot(profileId, index, instancesRoot)
  if (existsSync(target)) throw new Error('目标实例目录已存在，恢复操作拒绝覆盖')
  copySafeTree(source, target)
  return target
}
