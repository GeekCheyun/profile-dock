import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readJsonWithBackup, writeJsonAtomic } from '../server/util.js'

test('atomic JSON persistence retains a recoverable backup', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-json-'))
  const file = path.join(dir, 'state.json')
  try {
    writeJsonAtomic(file, { generation: 1 })
    writeJsonAtomic(file, { generation: 2 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { generation: 2 })
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { generation: 1 })

    writeFileSync(file, '{corrupted', 'utf8')
    const recovered = readJsonWithBackup<{ generation: number }>(file)
    assert.equal(recovered?.recoveredFromBackup, true)
    assert.equal(recovered?.value.generation, 1)
  } finally {
    assert.ok(dir.startsWith(os.tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})
