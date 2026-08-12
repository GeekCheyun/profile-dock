// 后端共享类型

/** 实例指纹配置 —— 每个实例独立的環境标识，用于防关联 */
export interface InstanceFingerprint {
  timezone: string // 时区，如 Asia/Shanghai
  language: string // 语言，如 zh-CN
  locale: string // 区域设置，如 zh-CN
  proxy: string // 代理地址，如 http://127.0.0.1:7890（空=直连）
  hostname: string // 模拟主机名，如 DESKTOP-A1B2C3
  userAgent: string // 模拟 User-Agent（主要针对浏览器）
  // 浏览器层指纹（通过 CDP 注入，覆盖 JS 可读的 navigator/screen/WebGL/Canvas/Audio）
  platform: string // navigator.platform，如 Win32
  hardwareConcurrency: number // navigator.hardwareConcurrency，如 8
  deviceMemory: number // navigator.deviceMemory，如 8（GB）
  screenWidth: number // screen.width
  screenHeight: number // screen.height
  colorDepth: number // screen.colorDepth，如 24
  webglVendor: string // WebGL UNMASKED_VENDOR，如 Google Inc. (NVIDIA)
  webglRenderer: string // WebGL UNMASKED_RENDERER，如 ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)
  canvasSeed: number // Canvas 指纹随机种子（用于确定性噪声注入）
  audioSeed: number // AudioContext 指纹随机种子
  machineGuid: string // Windows MachineGuid（设备唯一标识，注册表隔离用）
  // 硬件信息隔离：exchangeToken 请求体中的 DeviceBrand/DeviceCPU/DeviceModel 字段
  // 服务器通过这些硬件组合识别物理设备，不隔离会导致所有实例被识别为同一台机器
  hardwareBrand: string // 设备品牌，如 Dell, Lenovo, ASUS（对应 DeviceBrand）
  hardwareCPU: string // CPU 型号描述，如 Intel Core i7-11800H（对应 DeviceCPU）
  hardwareModel: string // 设备型号，如 XPS 15 9510（对应 DeviceModel）
}

/** 档案级指纹策略配置 */
export interface FingerprintConfig {
  enabled: boolean // 是否启用指纹隔离
  proxyList: string[] // 代理池（按实例顺序分配，不足时循环）
  timezonePool: string[] // 时区池（随机分配）
  languagePool: string[] // 语言池（随机分配）
  generateHostname: boolean // 自动生成唯一主机名
  customUserAgent: string // 自定义 UA（空=不注入）
  /** 指纹区域分类：domestic=国内 international=国际 mixed=混合（默认） */
  region: 'domestic' | 'international' | 'mixed'
}

/** 可信网络出口；不支持把代理账号密码写入项目配置。 */
export interface EgressConfig {
  enabled: boolean
  proxyUrl: string
}

/** 持久化的实例记录 —— 关闭应用后仍保留，除非主动删除 */
export interface InstanceRecord {
  id: string // 实例唯一 ID
  profileId: string // 所属档案 ID
  index: number // 实例序号（从 1 开始）
  box: string // Sandboxie 沙箱名
  name: string // 实例显示名称
  createdAt: number // 创建时间戳
  lastLaunchedAt: number // 最后启动时间戳
  fingerprint: InstanceFingerprint // 该实例的独立指纹
  pendingClearData?: boolean // 换指纹后标记，重启时清除浏览器数据（cookies/localStorage等）
}

export interface Profile {
  id: string
  name: string
  appPath: string // 目标程序完整路径
  appArgs: string // 启动参数
  workDir: string // 工作目录（留空则取 appPath 所在目录）
  boxPrefix: string // 沙箱名前缀，实例沙箱名为 `${boxPrefix}-${n}`
  openPaths: string[] // 共享的真实文件夹列表（所有实例共同读写）
  defaultCount: number // 默认多开数量
  cleanOnClose: boolean // 关闭实例时是否清空该沙箱内容（清除登录态等）
  boxNameTitle: boolean // 窗口标题是否附加沙箱名以便区分实例
  extraIni: string // 高级：额外写入每个沙箱的 ini 行（每行 Key=Value，按 set 语义）
  fingerprint: FingerprintConfig // 指纹隔离配置
  egress?: EgressConfig // 可信出口配置，验证失败时启动闭锁
}

export interface AppConfig {
  port: number
  profiles: Profile[]
  instances: InstanceRecord[] // 持久化的实例列表
}

/** 实例生命周期状态；运行状态由 manifest 持久化，不能只靠 PID 推断。 */
export type InstanceState =
  | 'created'
  | 'preparing'
  | 'starting'
  | 'process_ready'
  | 'egress_verified'
  | 'browser_verified'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'quarantined'

/** 实例运行时状态（实时查询，不持久化） */
export interface InstanceInfo {
  index: number
  box: string
  running: boolean
  pidCount: number
  pids: number[]
  fingerprint?: InstanceFingerprint // 关联的指纹（如果存在）
  name?: string // 实例名称
  createdAt?: number // 创建时间
  proxyAlive?: boolean | null // 代理可用性（null=无代理，true=可用，false=失效）
  state?: InstanceState // manifest 生命周期状态
}

export interface EnvInfo {
  installed: boolean
  startExe: string
  sbieIniExe: string
  dir: string
  isAdmin: boolean
  version: string
  serviceRunning: boolean
  bundled: boolean // 是否使用项目内置的 Sandboxie
}
