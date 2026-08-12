// 日志模块 —— 写入文件 + 控制台输出
// 日志文件位置：userData/logs/app.log
// 自动按日轮转，保留最近 7 天

import { appendFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './util.js'

const LOG_DIR = path.join(ROOT, 'data', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'app.log')
const MAX_DAYS = 7

// 确保日志目录存在
if (!existsSync(LOG_DIR)) {
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
}

/** 获取当前时间戳 */
function ts(): string {
  const d = new Date()
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

/** 获取当前日期（用于轮转） */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 清理过期日志（启动时执行一次） */
export function cleanOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - MAX_DAYS)
    for (const f of files) {
      if (!f.endsWith('.log')) continue
      const m = f.match(/(\d{4}-\d{2}-\d{2})/)
      if (m && new Date(m[1]) < cutoff) {
        try { unlinkSync(path.join(LOG_DIR, f)) } catch {}
      }
    }
  } catch {}
}

/** 写入日志 */
function write(level: string, msg: string): void {
  const line = `[${ts()}] [${level}] ${msg}\n`
  // 控制台输出（开发模式可见）
  if (level === 'ERROR') console.error(line.trimEnd())
  else console.log(line.trimEnd())
  // 文件输出
  try {
    // 按日轮转：文件名含日期
    const dailyFile = path.join(LOG_DIR, `app-${today()}.log`)
    appendFileSync(dailyFile, line, 'utf-8')
    // 同时写入主日志文件（兼容旧逻辑）
    appendFileSync(LOG_FILE, line, 'utf-8')
  } catch {}
}

export const logger = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
}

// 启动时清理过期日志
cleanOldLogs()
