import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): { get(...params: unknown[]): any; run(...params: unknown[]): any }
  close(): void
}

function openDatabase(file: string): SqliteDatabase {
  const require = createRequire(import.meta.url)
  let DatabaseSync: new (path: string) => SqliteDatabase
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync
  } catch (error: any) {
    throw new Error(`当前运行时缺少 node:sqlite；商用版需要 Electron 43+/Node 22+（${error?.message || error}）`)
  }
  const dir = path.dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata_documents (
      document_key TEXT PRIMARY KEY,
      document_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  const mode = db.prepare('PRAGMA journal_mode').get()?.journal_mode
  if (String(mode).toLowerCase() !== 'wal') {
    db.close()
    throw new Error(`SQLite WAL 未启用：${String(mode)}`)
  }
  return db
}

export class MetadataStore {
  constructor(private readonly file: string) {}

  readConfig<T>(): T | null {
    const db = openDatabase(this.file)
    try {
      const row = db.prepare('SELECT document_json FROM metadata_documents WHERE document_key = ?').get('app-config')
      if (!row?.document_json) return null
      try { return JSON.parse(String(row.document_json)) as T } catch { return null }
    } finally {
      db.close()
    }
  }

  writeConfig(value: unknown): void {
    const db = openDatabase(this.file)
    try {
      db.prepare(`
        INSERT INTO metadata_documents(document_key, document_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(document_key) DO UPDATE SET
          document_json = excluded.document_json,
          updated_at = excluded.updated_at
      `).run('app-config', JSON.stringify(value), Date.now())
    } finally {
      db.close()
    }
  }

  getJournalMode(): string {
    const db = openDatabase(this.file)
    try { return String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || '') } finally { db.close() }
  }
}
