// DLL 注入器 —— 使用 koffi 调用 Windows API
//
// 功能：
// 1. 以 CREATE_SUSPENDED 模式创建目标进程
// 2. 注入 hook DLL 到目标进程（CreateRemoteThread + LoadLibraryW）
// 3. 等待 DLL 加载完成后恢复进程执行
//
// 这样确保 hook DLL 在目标进程任何代码执行前加载，
// Mutex/Event 等命名对象的 hook 能在第一时间生效。
//
// 许可证：MIT（koffi 库也是 MIT）

import koffi from 'koffi'
import path from 'node:path'
import { existsSync } from 'node:fs'

const kernel32 = koffi.load('kernel32.dll')

// Windows API 函数声明
// koffi func 签名: func(convention, name, result, arguments)
// 注意 name 在 result 之前（之前写反了导致 "invalid type name 'CreateProcessW'"）
const CreateProcessW = kernel32.func('__stdcall', 'CreateProcessW', 'bool', [
  'const uint16_t *', // lpApplicationName
  'uint16_t *',       // lpCommandLine (可变)
  'void *',           // lpProcessAttributes
  'void *',           // lpThreadAttributes
  'bool',             // bInheritHandles
  'uint32_t',         // dwCreationFlags
  'void *',           // lpEnvironment
  'const uint16_t *', // lpCurrentDirectory
  'void *',           // lpStartupInfo (指针)
  'void *'            // lpProcessInformation (输出指针)
])

const VirtualAllocEx = kernel32.func('__stdcall', 'VirtualAllocEx', 'void *', [
  'void *',    // hProcess
  'void *',    // lpAddress
  'size_t',    // dwSize
  'uint32_t',  // flAllocationType
  'uint32_t'   // flProtect
])

const WriteProcessMemory = kernel32.func('__stdcall', 'WriteProcessMemory', 'bool', [
  'void *',        // hProcess
  'void *',        // lpBaseAddress
  'const void *',  // lpBuffer
  'size_t',        // nSize
  'size_t *'       // lpNumberOfBytesWritten (可选)
])

const GetProcAddress = kernel32.func('__stdcall', 'GetProcAddress', 'void *', [
  'void *',       // hModule
  'const char *'  // lpProcName
])

const GetModuleHandleW = kernel32.func('__stdcall', 'GetModuleHandleW', 'void *', [
  'const uint16_t *' // lpModuleName
])

const CreateRemoteThread = kernel32.func('__stdcall', 'CreateRemoteThread', 'void *', [
  'void *',     // hProcess
  'void *',     // lpThreadAttributes
  'size_t',     // dwStackSize
  'void *',     // lpStartAddress
  'void *',     // lpParameter
  'uint32_t',   // dwCreationFlags
  'uint32_t *'  // lpThreadId (可选)
])

const WaitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint32_t', [
  'void *',   // hHandle
  'uint32_t'  // dwMilliseconds
])

const ResumeThread = kernel32.func('__stdcall', 'ResumeThread', 'uint32_t', [
  'void *' // hThread
])

const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', [
  'void *' // hObject
])

const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32_t', [])

const CreateEventW = kernel32.func('__stdcall', 'CreateEventW', 'void *', [
  'void *',           // lpEventAttributes
  'bool',             // bManualReset
  'bool',             // bInitialState
  'const uint16_t *'  // lpName
])

// GetExitCodeThread（用于检查 LoadLibraryW 的返回值）
const GetExitCodeThread = kernel32.func('__stdcall', 'GetExitCodeThread', 'bool', [
  'void *',    // hThread
  'uint32_t *' // lpExitCode (输出)
])

// OpenProcess（用于向已存在进程注入 DLL）
const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', [
  'uint32_t',  // dwDesiredAccess
  'bool',      // bInheritHandle
  'uint32_t'   // dwProcessId
])

// 常量
const CREATE_SUSPENDED = 0x00000004
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
const MEM_COMMIT = 0x00001000
const MEM_RESERVE = 0x00002000
const PAGE_READWRITE = 0x04
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 258
const INFINITE = 0xFFFFFFFF

// 进程访问权限：PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE |
//               PROCESS_VM_READ | PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION
// 0x0002 = PROCESS_CREATE_THREAD：CreateRemoteThread 必需，缺失会导致
// 以普通权限运行时 OpenProcess 回退注入失败（Access Denied）。
const PROCESS_ACCESS_RIGHTS = 0x0002 | 0x000F0000 | 0x0008 | 0x0010 | 0x0020 | 0x0400 | 0x1000

// STARTUPINFOW 结构大小（字节）
const STARTUPINFOW_SIZE = 104  // 64位下 sizeof(STARTUPINFOW) = 104
const PROCESS_INFORMATION_SIZE = 24 // sizeof(PROCESS_INFORMATION) = 24

/**
 * 以挂起模式创建进程并注入 hook DLL
 *
 * @param appPath 目标程序完整路径
 * @param args 启动参数数组
 * @param workDir 工作目录
 * @param env 环境变量对象
 * @param dllPath hook DLL 的完整路径
 * @returns 成功返回 PID，失败返回错误
 */
export function launchWithDllInjection(
  appPath: string,
  args: string[],
  workDir: string,
  env: Record<string, string>,
  dllPath: string
): { ok: boolean; pid?: number; error?: string } {
  if (!existsSync(appPath)) {
    return { ok: false, error: `目标程序不存在: ${appPath}` }
  }
  if (!existsSync(dllPath)) {
    return { ok: false, error: `hook DLL 不存在: ${dllPath}` }
  }

  // 构建命令行字符串（UTF-16）
  const cmdLine = `"${appPath}" ${args.join(' ')}`
  const cmdLineBuf = Buffer.from(cmdLine + '\0', 'utf16le')
  const appPathBuf = Buffer.from(appPath + '\0', 'utf16le')
  const workDirBuf = workDir ? Buffer.from(workDir + '\0', 'utf16le') : null

  // 构建环境变量块（UTF-16，双 null 结尾）
  const envBlock = buildEnvironmentBlock(env)

  // 分配 STARTUPINFOW 和 PROCESS_INFORMATION 结构
  const startupInfo = Buffer.alloc(STARTUPINFOW_SIZE, 0)
  startupInfo.writeUInt32LE(STARTUPINFOW_SIZE, 0) // cb = sizeof(STARTUPINFOW)
  const processInfo = Buffer.alloc(PROCESS_INFORMATION_SIZE, 0)

  // 创建挂起的进程
  const created = CreateProcessW(
    appPathBuf,
    cmdLineBuf,
    null,
    null,
    false,
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
    envBlock,
    workDirBuf,
    startupInfo,
    processInfo
  )

  if (!created) {
    const err = GetLastError()
    return { ok: false, error: `CreateProcessW 失败 (错误码: ${err})` }
  }

  // 读取 PROCESS_INFORMATION 结构（64位：HANDLE 是 8 字节）
  const hProcess = processInfo.readBigUInt64LE(0)
  const hThread = processInfo.readBigUInt64LE(8)
  const pid = processInfo.readUInt32LE(16)

  // 调试日志：记录 processInfo Buffer 的原始内容
  console.log(`[Injector] processInfo raw: ${Buffer.from(processInfo).toString('hex')}`)

  console.log(`[Injector] CreateProcessW 成功: pid=${pid}, hProcess=${hProcess}, hThread=${hThread}`)

  // 注入 hook DLL
  const injectResult = injectDll(hProcess, dllPath, pid)
  console.log(`[Injector] injectDll 结果: ok=${injectResult.ok}, error=${injectResult.error || '无'}`)

  // 恢复主线程执行（无论注入是否成功都恢复，否则进程会永远挂起）
  ResumeThread(hThread)

  // 关闭句柄
  CloseHandle(hThread)
  CloseHandle(hProcess)

  if (!injectResult.ok) {
    // 注入失败：打印详细错误，但仍返回 ok=true（进程已启动）
    // engine.ts 中的 injectDllByPid 双保险会再次尝试注入
    console.error(`[Injector] DLL 注入失败: ${injectResult.error}`)
    return { ok: true, pid, error: `进程已启动但 DLL 注入失败: ${injectResult.error}` }
  }

  console.log(`[Injector] DLL 注入成功: pid=${pid}`)
  return { ok: true, pid }
}

/** 注入 DLL 到目标进程 */
function injectDll(hProcess: any, dllPath: string, pid: number): { ok: boolean; error?: string } {
  const initEventName = `Local\\WorkBuddyMultiopenInit_${pid}`
  const initEventNameBuf = Buffer.from(initEventName + '\0', 'utf16le')
  const hInitEvent = CreateEventW(null, true, false, initEventNameBuf)
  if (!hInitEvent) {
    return { ok: false, error: `创建 DLL 初始化事件失败 (pid=${pid}, err=${GetLastError()})` }
  }
  // 1. 在目标进程分配内存存放 DLL 路径（UTF-16）
  const dllPathBuf = Buffer.from(dllPath + '\0', 'utf16le')
  const dllPathSize = dllPathBuf.length

  const remoteBuf = VirtualAllocEx(hProcess, null, dllPathSize, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
  if (!remoteBuf) {
    const err = GetLastError()
    CloseHandle(hInitEvent)
    return { ok: false, error: `VirtualAllocEx 失败 (err=${err}, hProcess=${hProcess})` }
  }

  // 2. 写入 DLL 路径到目标进程
  const written = WriteProcessMemory(hProcess, remoteBuf, dllPathBuf, dllPathSize, null)
  if (!written) {
    const err = GetLastError()
    CloseHandle(hInitEvent)
    return { ok: false, error: `WriteProcessMemory 失败 (err=${err})` }
  }

  // 3. 获取 LoadLibraryW 的地址
  const kernel32NameBuf = Buffer.from('kernel32.dll\0', 'utf16le')
  const hKernel32 = GetModuleHandleW(kernel32NameBuf)
  if (!hKernel32) {
    const err = GetLastError()
    CloseHandle(hInitEvent)
    return { ok: false, error: `GetModuleHandleW(kernel32.dll) 失败 (err=${err})` }
  }

  const loadLibraryAddr = GetProcAddress(hKernel32, 'LoadLibraryW')
  if (!loadLibraryAddr) {
    const err = GetLastError()
    CloseHandle(hInitEvent)
    return { ok: false, error: `GetProcAddress(LoadLibraryW) 失败 (err=${err})` }
  }

  // 4. 创建远程线程调用 LoadLibraryW(dllPath)
  const hRemoteThread = CreateRemoteThread(hProcess, null, 0, loadLibraryAddr, remoteBuf, 0, null)
  if (!hRemoteThread) {
    const err = GetLastError()
    CloseHandle(hInitEvent)
    return { ok: false, error: `CreateRemoteThread 失败 (err=${err})` }
  }

  // 5. 等待远程线程完成（DLL 加载完毕）
  const waitResult = WaitForSingleObject(hRemoteThread, 10000) // 最多等 10 秒

  // 6. 检查 LoadLibraryW 的返回值（远程线程的退出码 = LoadLibraryW 的返回值）
  //    如果返回 0，说明 LoadLibraryW 失败（DLL 路径错误或 DLL 加载出错）
  let exitCode = 0
  if (waitResult === WAIT_OBJECT_0) {
    const exitCodeBuf = Buffer.alloc(4, 0)
    GetExitCodeThread(hRemoteThread, exitCodeBuf)
    exitCode = exitCodeBuf.readUInt32LE(0)
  }

  CloseHandle(hRemoteThread)

  if (waitResult === WAIT_TIMEOUT) {
    CloseHandle(hInitEvent)
    return { ok: false, error: 'DLL 注入超时' }
  }

  if (waitResult !== WAIT_OBJECT_0) {
    CloseHandle(hInitEvent)
    return { ok: false, error: `等待 LoadLibraryW 失败 (wait=${waitResult}, err=${GetLastError()})` }
  }

  if (exitCode === 0) {
    CloseHandle(hInitEvent)
    return { ok: false, error: `LoadLibraryW 返回 NULL（DLL 加载失败，可能路径错误或依赖缺失）` }
  }

  const initWait = WaitForSingleObject(hInitEvent, 8000)
  CloseHandle(hInitEvent)
  if (initWait !== WAIT_OBJECT_0) {
    const kind = initWait === WAIT_TIMEOUT ? '超时' : `失败 (wait=${initWait}, err=${GetLastError()})`
    return { ok: false, error: `DLL 已加载但初始化握手${kind} (pid=${pid})` }
  }

  return { ok: true }
}

/** 构建环境变量块（UTF-16，格式：KEY=VALUE\0...KEY=VALUE\0\0） */
function buildEnvironmentBlock(env: Record<string, string>): Buffer {
  const entries: Buffer[] = []
  for (const [key, value] of Object.entries(env)) {
    const entry = `${key}=${value}\0`
    entries.push(Buffer.from(entry, 'utf16le'))
  }
  entries.push(Buffer.from('\0', 'utf16le')) // 双 null 结尾
  return Buffer.concat(entries)
}

/**
 * 向已存在的进程注入 hook DLL（不创建新进程）
 *
 * 用途：launcher 退出后，box 的"主进程"（Chromium 主进程/IDE 主进程）已经派生出来，
 *       但 hook DLL 还没通过 QueueUserAPC 装上（子线程还没进入 alertable 状态）。
 *       这时显式注入一次，确保主进程的 ShellExecuteW / CreateProcessW hook 立即生效。
 *
 * @param pid 目标进程 PID
 * @param dllPath hook DLL 完整路径
 * @returns 成功返回 ok，失败返回错误
 */
export function injectDllByPid(
  pid: number,
  dllPath: string
): { ok: boolean; error?: string } {
  if (!pid || pid <= 0) return { ok: false, error: '无效 PID' }
  if (!existsSync(dllPath)) return { ok: false, error: `DLL 不存在: ${dllPath}` }

  const hProcess = OpenProcess(PROCESS_ACCESS_RIGHTS, false, pid)
  if (!hProcess) {
    const err = GetLastError()
    return { ok: false, error: `OpenProcess 失败 PID=${pid} err=${err}（可能进程已退出或无权限）` }
  }

  try {
    const result = injectDll(hProcess, dllPath, pid)
    return result
  } finally {
    CloseHandle(hProcess)
  }
}
