import koffi from 'koffi'

const kernel32 = koffi.load('kernel32.dll')
const CreateJobObjectW = kernel32.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'void *'])
const SetInformationJobObject = kernel32.func('__stdcall', 'SetInformationJobObject', 'bool', ['void *', 'uint32_t', 'void *', 'uint32_t'])
const AssignProcessToJobObject = kernel32.func('__stdcall', 'AssignProcessToJobObject', 'bool', ['void *', 'void *'])
const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32_t', 'bool', 'uint32_t'])
const TerminateJobObject = kernel32.func('__stdcall', 'TerminateJobObject', 'bool', ['void *', 'uint32_t'])
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *'])

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

const jobs = new Map<string, any>()

function configureJob(handle: any): boolean {
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on Windows x64;
  // LimitFlags is the DWORD at offset 16 in the embedded basic structure.
  const info = Buffer.alloc(144)
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16)
  return Boolean(SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.length))
}

/** 将实例主进程加入 Job Object；子进程默认继承 Job 边界。 */
export function attachProcessToJob(instanceKey: string, pid: number): boolean {
  if (process.platform !== 'win32' || !instanceKey || !pid || pid <= 0) return false
  let job = jobs.get(instanceKey)
  if (!job) {
    job = CreateJobObjectW(null, null)
    if (!job || !configureJob(job)) {
      if (job) CloseHandle(job)
      return false
    }
  }
  const processHandle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!processHandle || !AssignProcessToJobObject(job, processHandle)) {
    if (processHandle) CloseHandle(processHandle)
    if (!jobs.has(instanceKey)) CloseHandle(job)
    return false
  }
  CloseHandle(processHandle)
  if (!jobs.has(instanceKey)) jobs.set(instanceKey, job)
  return true
}

/** 结束实例 Job Object 中的全部进程，并释放句柄。 */
export function terminateInstanceJob(instanceKey: string): boolean {
  const job = jobs.get(instanceKey)
  if (!job) return false
  jobs.delete(instanceKey)
  const terminated = Boolean(TerminateJobObject(job, 0))
  CloseHandle(job)
  return terminated
}

export function releaseInstanceJob(instanceKey: string): void {
  const job = jobs.get(instanceKey)
  if (!job) return
  jobs.delete(instanceKey)
  CloseHandle(job)
}
