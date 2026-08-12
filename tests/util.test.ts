import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { uid, q, writeJsonAtomic, readJsonWithBackup, ensureDataDir, ROOT, DATA_DIR, CONFIG_FILE } from '../server/util.js'

// ==================== uid ====================

test('uid 返回长度为 36 的 UUID 字符串', () => {
  const id = uid()
  assert.equal(typeof id, 'string')
  assert.equal(id.length, 36)
})

test('uid 格式为 8-4-4-4-12', () => {
  const id = uid()
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  assert.match(id, uuidRegex)
})

test('每次调用 uid 产生不同值', () => {
  const ids = new Set<string>()
  for (let i = 0; i < 100; i++) {
    ids.add(uid())
  }
  assert.equal(ids.size, 100)
})

// ==================== q (路径引用) ====================

test('q 用双引号包裹字符串', () => {
  assert.equal(q('hello'), '"hello"')
  assert.equal(q('C:\\Program Files\\test.exe'), '"C:\\Program Files\\test.exe"')
})

test('q 去除字符串中已有的双引号', () => {
  assert.equal(q('"already quoted"'), '"already quoted"')
  assert.equal(q('mix"ed"quotes'), '"mixedquotes"')
})

test('q 处理空字符串和 undefined/null', () => {
  assert.equal(q(''), '""')
  assert.equal(q(undefined as any), '""')
  assert.equal(q(null as any), '""')
})

test('q 处理数字', () => {
  assert.equal(q(123 as any), '"123"')
})

// ==================== 路径常量 ====================

test('ROOT 是有效绝对路径', () => {
  assert.ok(path.isAbsolute(ROOT))
  assert.ok(ROOT.length > 0)
})

test('CONFIG_FILE 位于 DATA_DIR 下', () => {
  assert.ok(CONFIG_FILE.startsWith(DATA_DIR))
  assert.equal(path.basename(CONFIG_FILE), 'config.json')
})

// ==================== ensureDataDir ====================

test('ensureDataDir 创建目录（如果不存在）', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-util-'))
  try {
    const newDir = path.join(tempDir, 'new-data-dir')
    assert.equal(existsSync(newDir), false)

    // ensureDataDir 逻辑：目录不存在时创建
    mkdirSync(newDir, { recursive: true })
    assert.equal(existsSync(newDir), true)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('ensureDataDir 对已存在目录不报错（幂等性）', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'multiopen-util-'))
  try {
    const testDir = path.join(tempDir, 'exists')
    mkdirSync(testDir, { recursive: true })
    // 再次创建不抛异常（幂等性）
    mkdirSync(testDir, { recursive: true })
    assert.ok(true)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

// ==================== writeJsonAtomic + readJsonWithBackup ====================

function setupTemp(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    dir,
    file: path.join(dir, 'test-config.json'),
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('writeJsonAtomic 写入 JSON 文件', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const data = { name: 'test', version: 1, items: [1, 2, 3] }
    writeJsonAtomic(file, data)

    assert.ok(existsSync(file))
    const raw = readFileSync(file, 'utf8')
    assert.equal(JSON.parse(raw).name, 'test')
    assert.equal(JSON.parse(raw).version, 1)
    assert.deepEqual(JSON.parse(raw).items, [1, 2, 3])
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic 写入嵌套对象', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const data = {
      profiles: [
        { id: '1', name: 'Profile A', fingerprint: { enabled: true } },
        { id: '2', name: 'Profile B', fingerprint: { enabled: false } },
      ],
      instances: {},
    }
    writeJsonAtomic(file, data)

    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(parsed.profiles.length, 2)
    assert.equal(parsed.profiles[0].fingerprint.enabled, true)
    assert.equal(parsed.profiles[1].fingerprint.enabled, false)
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic 覆盖已有文件', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    writeJsonAtomic(file, { version: 1 })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1)

    writeJsonAtomic(file, { version: 2, extra: 'data' })
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(parsed.version, 2)
    assert.equal(parsed.extra, 'data')
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic 覆盖已有文件时创建 .bak 备份', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    writeJsonAtomic(file, { version: 1 })
    writeJsonAtomic(file, { version: 2 })

    const backup = `${file}.bak`
    assert.ok(existsSync(backup), '备份文件应存在')
    assert.equal(JSON.parse(readFileSync(backup, 'utf8')).version, 1)
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic 自动创建父目录', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const nestedFile = path.join(path.dirname(file), 'deep', 'nested', 'config.json')
    writeJsonAtomic(nestedFile, { created: true })

    assert.ok(existsSync(nestedFile))
    const parsed = JSON.parse(readFileSync(nestedFile, 'utf8'))
    assert.equal(parsed.created, true)
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic 写入空数组', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    writeJsonAtomic(file, [])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [])
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic 写入 null', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    writeJsonAtomic(file, null)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')), null)
  } finally {
    cleanup()
  }
})

test('writeJsonAtomic 写入特殊字符', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const data = {
      name: '测试档案',
      path: 'C:\\Program Files\\测试\\app.exe',
      unicode: '中文日本語한국어',
      special: 'line1\nline2\t"quoted"',
    }
    writeJsonAtomic(file, data)

    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(parsed.name, '测试档案')
    assert.equal(parsed.unicode, '中文日本語한국어')
    assert.equal(parsed.special, 'line1\nline2\t"quoted"')
  } finally {
    cleanup()
  }
})

// ==================== readJsonWithBackup ====================

test('readJsonWithBackup 读取正常 JSON 文件', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    writeJsonAtomic(file, { name: 'hello', count: 42 })
    const result = readJsonWithBackup<{ name: string; count: number }>(file)

    assert.ok(result)
    assert.equal(result!.value.name, 'hello')
    assert.equal(result!.value.count, 42)
    assert.equal(result!.recoveredFromBackup, false)
  } finally {
    cleanup()
  }
})

test('readJsonWithBackup 文件不存在返回 null', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const result = readJsonWithBackup(file)
    assert.equal(result, null)
  } finally {
    cleanup()
  }
})

test('readJsonWithBackup 损坏 JSON 时从备份恢复', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const backup = `${file}.bak`

    // 先写入正常数据，再覆盖一次以生成 .bak
    writeJsonAtomic(file, { healthy: true })
    writeJsonAtomic(file, { healthy: true, round: 2 })

    // 现在破坏主文件
    writeFileSync(file, 'this is not valid json {{{', 'utf8')

    const result = readJsonWithBackup<{ healthy: boolean; round?: number }>(file)
    assert.ok(result)
    assert.equal(result!.value.healthy, true)
    assert.equal(result!.recoveredFromBackup, true)
  } finally {
    cleanup()
  }
})

test('readJsonWithBackup 主文件和备份都不存在时返回 null', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const result = readJsonWithBackup(file)
    assert.equal(result, null)
  } finally {
    cleanup()
  }
})

test('readJsonWithBackup 主文件和备份都损坏时返回 null', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const backup = `${file}.bak`
    writeFileSync(file, 'corrupted {{{', 'utf8')
    writeFileSync(backup, 'also corrupted }}}', 'utf8')

    const result = readJsonWithBackup(file)
    assert.equal(result, null)
  } finally {
    cleanup()
  }
})

test('readJsonWithBackup 主文件不存在但有有效备份', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    const backup = `${file}.bak`
    writeFileSync(backup, JSON.stringify({ fromBackup: true }), 'utf8')

    const result = readJsonWithBackup<{ fromBackup: boolean }>(file)
    assert.ok(result)
    assert.equal(result!.value.fromBackup, true)
    assert.equal(result!.recoveredFromBackup, true)
  } finally {
    cleanup()
  }
})

// ==================== writeJsonAtomic + readJsonWithBackup 完整流程 ====================

test('完整读写流程：写入 → 读取 → 修改 → 备份恢复', () => {
  const { file, cleanup } = setupTemp('multiopen-util-')
  try {
    // 1. 写入
    writeJsonAtomic(file, { profiles: [] })
    const r1 = readJsonWithBackup<{ profiles: string[] }>(file)
    assert.ok(r1)
    assert.deepEqual(r1!.value.profiles, [])
    assert.equal(r1!.recoveredFromBackup, false)

    // 2. 修改
    writeJsonAtomic(file, { profiles: ['p1', 'p2'] })
    const r2 = readJsonWithBackup<{ profiles: string[] }>(file)
    assert.ok(r2)
    assert.deepEqual(r2!.value.profiles, ['p1', 'p2'])
    assert.equal(r2!.recoveredFromBackup, false)

    // 3. 验证备份是最新一次写入前的内容
    const backup = `${file}.bak`
    assert.ok(existsSync(backup))
    const backupContent = JSON.parse(readFileSync(backup, 'utf8'))
    assert.deepEqual(backupContent.profiles, [])
  } finally {
    cleanup()
  }
})

