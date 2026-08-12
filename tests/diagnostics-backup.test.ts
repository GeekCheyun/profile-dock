import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createDiagnosticReport } from '../server/diagnostics.js'
import { backupInstance, restoreInstanceBackup } from '../server/backup.js'

test('backup restore rejects a malformed manifest as an incomplete backup', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-backup-malformed-'))
  try {
    const backup = path.join(dir, 'backup')
    mkdirSync(path.join(backup, 'instance'), { recursive: true })
    writeFileSync(path.join(backup, 'backup-manifest.json'), '{not-json', 'utf8')
    assert.throws(
      () => restoreInstanceBackup(backup, 'profile-1', 1, path.join(dir, 'instances')),
      /备份目录不完整/,
    )
  } finally {
    assert.ok(dir.startsWith(os.tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup restore refuses to overwrite an existing instance', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-backup-existing-'))
  try {
    const instancesRoot = path.join(dir, 'instances')
    const target = path.join(instancesRoot, 'profile-1', '1')
    const backup = path.join(dir, 'backup')
    mkdirSync(target, { recursive: true })
    mkdirSync(path.join(backup, 'instance'), { recursive: true })
    writeFileSync(path.join(backup, 'backup-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      backupId: 'profile-1-1-test',
      profileId: 'profile-1',
      index: 1,
    }), 'utf8')
    assert.throws(
      () => restoreInstanceBackup(backup, 'profile-1', 1, instancesRoot),
      /目标实例目录已存在，恢复操作拒绝覆盖/,
    )
  } finally {
    assert.ok(dir.startsWith(os.tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup restore rejects a manifest for a different instance', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-backup-mismatch-'))
  try {
    const backup = path.join(dir, 'backup')
    mkdirSync(path.join(backup, 'instance'), { recursive: true })
    writeFileSync(path.join(backup, 'backup-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      backupId: 'profile-1-1-test',
      profileId: 'profile-1',
      index: 1,
    }), 'utf8')
    assert.throws(
      () => restoreInstanceBackup(backup, 'profile-2', 1, path.join(dir, 'instances')),
      /备份与目标实例不匹配/,
    )
  } finally {
    assert.ok(dir.startsWith(os.tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('诊断报告只输出受管相对路径和明确限制', () => {
  const report = createDiagnosticReport({
    profileId: 'profile-1', index: 1, box: 'App-1',
    workDir: path.join(process.cwd(), 'engine', 'instances', 'profile-1', '1'),
    running: false, pidCount: 0,
  })
  assert.equal(report.instance.paths.workDir, '<instances>/profile-1/1')
  assert.equal(JSON.stringify(report).includes('Cookie'), true)
  assert.equal(JSON.stringify(report).includes(process.cwd()), false)
})

test('诊断报告对越界路径只返回 unmanaged 标记', () => {
  const report = createDiagnosticReport({
    profileId: 'profile-1', index: 1, box: 'App-1',
    workDir: path.join(os.tmpdir(), 'outside'), running: false, pidCount: 0,
  })
  assert.equal(report.instance.paths.workDir, '<unmanaged>')
})

test('实例备份跳过 shared 并拒绝覆盖式恢复', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-backup-test-'))
  try {
    const instancesRoot = path.join(dir, 'instances')
    const source = path.join(instancesRoot, 'profile-1', '1')
    mkdirSync(path.join(source, 'config'), { recursive: true })
    mkdirSync(path.join(source, 'shared'), { recursive: true })
    writeFileSync(path.join(source, 'config', 'state.json'), '{"ok":true}', 'utf8')
    writeFileSync(path.join(source, 'shared', 'user.txt'), 'user content', 'utf8')
    const backupRoot = path.join(dir, 'backups')
    const backup = backupInstance('profile-1', 1, backupRoot, instancesRoot)
    assert.equal(existsSync(path.join(backup, 'instance', 'config', 'state.json')), true)
    assert.equal(existsSync(path.join(backup, 'instance', 'shared', 'user.txt')), false)
    rmSync(source, { recursive: true, force: true })
    const restored = restoreInstanceBackup(backup, 'profile-1', 1, instancesRoot)
    assert.equal(restored, source)
    assert.equal(existsSync(path.join(restored, 'config', 'state.json')), true)
  } finally {
    assert.ok(dir.startsWith(os.tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})
