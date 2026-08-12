import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { MetadataStore } from '../server/metadata-store.js'

test('MetadataStore 使用 SQLite WAL 并可往返保存元数据', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-sqlite-'))
  try {
    const store = new MetadataStore(path.join(dir, 'metadata.sqlite'))
    assert.equal(store.getJournalMode().toLowerCase(), 'wal')
    const value = { port: 17890, profiles: [{ id: 'p1' }], instances: [] }
    store.writeConfig(value)
    assert.deepEqual(store.readConfig(), value)
  } finally {
    assert.ok(dir.startsWith(os.tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MetadataStore 通过单一文档键更新配置且不回显敏感内容', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-sqlite-update-'))
  try {
    const store = new MetadataStore(path.join(dir, 'metadata.sqlite'))
    store.writeConfig({ version: 1 })
    store.writeConfig({ version: 2 })
    assert.deepEqual(store.readConfig(), { version: 2 })
  } finally {
    assert.ok(dir.startsWith(os.tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})
