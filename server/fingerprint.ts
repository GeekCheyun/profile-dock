// 指纹生成模块 —— 为每个实例生成独立的环境标识，防止平台关联检测
//
// 设计原则：
// 用户只需提供代理地址（可选），其他全部自动分配且保证各实例不冲突。
//
// 防关联维度：
// 1. 网络隔离：每个实例分配独立代理，不同 IP 出网（需用户提供代理）
// 2. 时区隔离：不同时区让平台无法通过时区指纹关联（自动分配）
// 3. 语言隔离：不同语言/区域设置（自动分配）
// 4. 主机名隔离：不同的 COMPUTERNAME（自动生成，保证唯一）
// 5. UA 隔离：不同 User-Agent（自动分配）
//
// 这些值通过 Sandboxie 的 SetEnvironmentVar 和 ProxyServer 注入到每个沙箱。

import type { FingerprintConfig, InstanceFingerprint } from './types.js'

// 内置时区池（覆盖主要地区，共 50 个，支持最多 50 开不重复）
// 时区与下方 DEFAULT_LANGUAGES 一一对应，保证时区-语言合理性
const DEFAULT_TIMEZONES = [
  // 东亚
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Taipei',
  // 东南亚
  'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kuala_Lumpur', 'Asia/Manila', 'Asia/Jakarta',
  'Asia/Ho_Chi_Minh', 'Asia/Kolkata',
  // 中东
  'Asia/Dubai', 'Asia/Tehran', 'Asia/Riyadh',
  // 北美
  'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver',
  'America/Toronto', 'America/Vancouver', 'America/Mexico_City',
  // 南美
  'America/Sao_Paulo', 'America/Buenos_Aires', 'America/Santiago',
  // 欧洲
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Moscow', 'Europe/Istanbul',
  'Europe/Warsaw', 'Europe/Athens',
  // 大洋洲
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland',
  // 非洲
  'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Nairobi',
  // 其他
  'Pacific/Honolulu', 'America/Anchorage', 'Asia/Karachi', 'Asia/Dhaka',
  'Asia/Chongqing', 'Asia/Urumqi',
]

// 内置语言池（共 50 个，与时区一一对应，保证合理性）
const DEFAULT_LANGUAGES = [
  // 东亚
  'zh-CN', 'zh-HK', 'ja-JP', 'ko-KR', 'zh-TW',
  // 东南亚
  'en-SG', 'th-TH', 'ms-MY', 'en-PH', 'id-ID',
  'vi-VN', 'en-IN',
  // 中东
  'ar-AE', 'fa-IR', 'ar-SA',
  // 北美
  'en-US', 'en-US', 'en-US', 'en-US', 'en-CA',
  'en-CA', 'es-MX',
  // 南美
  'pt-BR', 'es-AR', 'es-CL',
  // 欧洲
  'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT',
  'nl-NL', 'sv-SE', 'ru-RU', 'tr-TR',
  'pl-PL', 'el-GR',
  // 大洋洲
  'en-AU', 'en-AU', 'en-AU', 'en-NZ',
  // 非洲
  'en-ZA', 'ar-EG', 'en-NG', 'sw-KE',
  // 其他
  'en-US', 'en-US', 'ur-PK', 'bn-BD',
  'zh-CN', 'zh-CN',
]

// ==================== 国内指纹池（亚洲地区，含中国/东亚/东南亚/南亚） ====================
// 用于 region='domestic' 场景：实例伪装为中国及周边亚洲地区设备
const DOMESTIC_TIMEZONES = [
  // 中国大陆及港澳台
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Urumqi', 'Asia/Chongqing',
  // 东亚
  'Asia/Tokyo', 'Asia/Seoul',
  // 东南亚
  'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kuala_Lumpur', 'Asia/Manila',
  'Asia/Jakarta', 'Asia/Ho_Chi_Minh',
  // 南亚
  'Asia/Kolkata', 'Asia/Karachi', 'Asia/Dhaka',
  // 中东
  'Asia/Dubai', 'Asia/Riyadh',
]

const DOMESTIC_LANGUAGES = [
  // 中国大陆及港澳台
  'zh-CN', 'zh-HK', 'zh-TW', 'zh-CN', 'zh-CN',
  // 东亚
  'ja-JP', 'ko-KR',
  // 东南亚
  'en-SG', 'th-TH', 'ms-MY', 'en-PH',
  'id-ID', 'vi-VN',
  // 南亚
  'en-IN', 'ur-PK', 'bn-BD',
  // 中东
  'ar-AE', 'ar-SA',
]

// ==================== 国际指纹池（欧美/大洋洲/非洲，不含亚洲） ====================
// 用于 region='international' 场景：实例伪装为欧美/其他地区设备
const INTERNATIONAL_TIMEZONES = [
  // 北美
  'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Denver',
  'America/Toronto', 'America/Vancouver', 'America/Mexico_City',
  // 南美
  'America/Sao_Paulo', 'America/Buenos_Aires', 'America/Santiago',
  // 欧洲
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Moscow', 'Europe/Istanbul',
  'Europe/Warsaw', 'Europe/Athens',
  // 大洋洲
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth', 'Pacific/Auckland',
  // 非洲
  'Africa/Johannesburg', 'Africa/Cairo', 'Africa/Lagos', 'Africa/Nairobi',
  // 太平洋
  'Pacific/Honolulu', 'America/Anchorage',
]

const INTERNATIONAL_LANGUAGES = [
  // 北美
  'en-US', 'en-US', 'en-US', 'en-US', 'en-CA', 'en-CA', 'es-MX',
  // 南美
  'pt-BR', 'es-AR', 'es-CL',
  // 欧洲
  'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT',
  'nl-NL', 'sv-SE', 'ru-RU', 'tr-TR', 'pl-PL', 'el-GR',
  // 大洋洲
  'en-AU', 'en-AU', 'en-AU', 'en-NZ',
  // 非洲
  'en-ZA', 'ar-EG', 'en-NG', 'sw-KE',
  // 太平洋
  'en-US', 'en-US',
]

// 主机名前缀池（模拟真实 Windows 设备名）
const HOSTNAME_PREFIXES = ['DESKTOP', 'LAPTOP', 'PC', 'WORKSTATION', 'SURFACE', 'W10', 'WIN', 'OFFICE', 'HOME', 'STUDIO']

// ==================== 浏览器层指纹池 ====================

// navigator.platform（所有 Windows 实例统一为 Win32，因为修改它反而异常）
const DEFAULT_PLATFORM = 'Win32'

// hardwareConcurrency 池（模拟真实 CPU 核心数分布）
const HARDWARE_CONCURRENCY_POOL = [4, 4, 6, 8, 8, 8, 12, 12, 16, 16]

// deviceMemory 池（Chromium 仅返回 2/4/8，不返回更高值）
const DEVICE_MEMORY_POOL = [4, 4, 8, 8, 8]

// 屏幕分辨率池（覆盖常见显示器分辨率）
const SCREEN_RESOLUTIONS: Array<[number, number]> = [
  [1920, 1080], [1920, 1080], [1920, 1080], [2560, 1440], [1366, 768],
  [1536, 864], [1440, 900], [1680, 1050], [1280, 720], [2560, 1080],
  [1920, 1200], [3840, 2160], [1600, 900], [1280, 1024], [1360, 768],
]

// WebGL GPU 配对池（vendor + renderer，必须配对合理）
const WEBGL_GPUS: Array<{ vendor: string; renderer: string }> = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Super Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0)' },
]

// ==================== 硬件信息隔离池 ====================
// exchangeToken 请求体中发送 DeviceBrand/DeviceModel/DeviceCPU 三个字段
// 服务器通过硬件组合识别物理设备，必须为每个实例分配不同的硬件指纹

// 品牌+型号配对池（品牌和型号必须匹配，否则容易被识别为伪造）
const HARDWARE_BRAND_MODELS: Array<{ brand: string; model: string }> = [
  { brand: 'Dell', model: 'XPS 15 9510' },
  { brand: 'Dell', model: 'XPS 13 9310' },
  { brand: 'Dell', model: 'Inspiron 15 5000' },
  { brand: 'Dell', model: 'Latitude 7420' },
  { brand: 'Lenovo', model: 'ThinkPad X1 Carbon Gen 9' },
  { brand: 'Lenovo', model: 'ThinkPad T14 Gen 2' },
  { brand: 'Lenovo', model: 'IdeaPad 5 Pro' },
  { brand: 'Lenovo', model: 'Yoga 9i' },
  { brand: 'HP', model: 'Spectre x360 14' },
  { brand: 'HP', model: 'Envy 15' },
  { brand: 'HP', model: 'Pavilion 15' },
  { brand: 'HP', model: 'EliteBook 840 G8' },
  { brand: 'ASUS', model: 'ZenBook 14 UX425' },
  { brand: 'ASUS', model: 'ROG Zephyrus G14' },
  { brand: 'ASUS', model: 'VivoBook 15' },
  { brand: 'ASUS', model: 'TUF Gaming F15' },
  { brand: 'Acer', model: 'Swift 3' },
  { brand: 'Acer', model: 'Predator Helios 300' },
  { brand: 'Acer', model: 'Aspire 7' },
  { brand: 'MSI', model: 'Modern 14' },
  { brand: 'MSI', model: 'Katana GF66' },
  { brand: 'MSI', model: 'Creator M16' },
  { brand: 'Microsoft', model: 'Surface Laptop 4' },
  { brand: 'Microsoft', model: 'Surface Pro 8' },
  { brand: 'Samsung', model: 'Galaxy Book Pro 15' },
  { brand: 'LG', model: 'Gram 17' },
  { brand: 'LG', model: 'Gram 14' },
  { brand: 'Razer', model: 'Blade 15' },
  { brand: 'Huawei', model: 'MateBook X Pro' },
  { brand: 'Xiaomi', model: 'RedmiBook Pro 15' },
]

// CPU 型号池（覆盖主流 Intel/AMD 桌面和移动端 CPU）
const HARDWARE_CPUS = [
  '12th Gen Intel(R) Core(TM) i5-12400',
  '12th Gen Intel(R) Core(TM) i7-12700',
  '12th Gen Intel(R) Core(TM) i7-12700H',
  '12th Gen Intel(R) Core(TM) i9-12900K',
  '11th Gen Intel(R) Core(TM) i5-1135G7',
  '11th Gen Intel(R) Core(TM) i7-1165G7',
  '11th Gen Intel(R) Core(TM) i7-11800H',
  '10th Gen Intel(R) Core(TM) i5-10400',
  '10th Gen Intel(R) Core(TM) i7-10700',
  'AMD Ryzen 5 5600X 6-Core Processor',
  'AMD Ryzen 5 5600H with Radeon Graphics',
  'AMD Ryzen 7 5800X 8-Core Processor',
  'AMD Ryzen 7 5800H with Radeon Graphics',
  'AMD Ryzen 9 5900X 12-Core Processor',
  'AMD Ryzen 7 6800H with Radeon Graphics',
]

// 常见 Windows User-Agent 模板（共 50 个，覆盖 Chrome/Edge/Firefox/Opera 多版本）
const USER_AGENT_TEMPLATES = [
  // Chrome 系列
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
  // Edge 系列
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  // Firefox 系列
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:117.0) Gecko/20100101 Firefox/117.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:116.0) Gecko/20100101 Firefox/116.0',
  // Opera 系列
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/110.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/109.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OPR/108.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
  // Chrome 115-110
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
  // Edge 旧版
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 Edg/117.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Edg/116.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/115.0.0.0',
  // Firefox 旧版
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:114.0) Gecko/20100101 Firefox/114.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:113.0) Gecko/20100101 Firefox/113.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:112.0) Gecko/20100101 Firefox/112.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:111.0) Gecko/20100101 Firefox/111.0',
  // Opera 旧版
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 OPR/104.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 OPR/103.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 OPR/102.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 OPR/101.0.0.0',
]

/**
 * 根据 region 配置选择时区/语言 fallback 池
 * - domestic: 仅使用亚洲地区池（国内场景）
 * - international: 仅使用欧美/大洋洲/非洲池（国际场景）
 * - mixed: 使用完整混合池（默认，兼容旧配置）
 */
function selectTimezonePool(region: string, userPool: string[]): string[] {
  if (userPool && userPool.length > 0) return userPool
  switch (region) {
    case 'domestic': return DOMESTIC_TIMEZONES
    case 'international': return INTERNATIONAL_TIMEZONES
    default: return DEFAULT_TIMEZONES
  }
}

function selectLanguagePool(region: string, userPool: string[]): string[] {
  if (userPool && userPool.length > 0) return userPool
  switch (region) {
    case 'domestic': return DOMESTIC_LANGUAGES
    case 'international': return INTERNATIONAL_LANGUAGES
    default: return DEFAULT_LANGUAGES
  }
}

/**
 * 按索引从池中选取（确定性，保证同一 index 总是拿到相同值，不同 index 拿到不同值）
 * 池为空时使用 fallback 池
 */
function pickByIndex<T>(userPool: T[], index: number, fallbackPool: T[]): T {
  const pool = userPool && userPool.length > 0 ? userPool : fallbackPool
  // index 从 1 开始，池从 0 开始
  return pool[(index - 1) % pool.length]
}

/**
 * 从池中随机选取一个元素（用于"换指纹"时生成全新指纹）
 */
function pickRandom<T>(userPool: T[], fallbackPool: T[]): T {
  const pool = userPool && userPool.length > 0 ? userPool : fallbackPool
  return pool[Math.floor(Math.random() * pool.length)]
}

/**
 * 生成随机 MachineGuid（Windows 设备唯一标识）
 * 格式：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx（大写十六进制）
 */
function generateMachineGuid(): string {
  const hex = '0123456789ABCDEF'
  const segments = [8, 4, 4, 4, 12]
  return segments.map(len =>
    Array.from({ length: len }, () => hex[Math.floor(Math.random() * 16)]).join('')
  ).join('-')
}

/**
 * 生成唯一主机名，包含 index 确保不重复
 * 格式：DESKTOP-A1B2C3-7（前缀-随机6字符-index）
 */
function generateHostname(index: number): string {
  const prefix = HOSTNAME_PREFIXES[index % HOSTNAME_PREFIXES.length]
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const random = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${prefix}-${random}${index}`
}

/**
 * 为实例生成独立指纹
 * 核心保证：同档案内不同 index 的实例，时区/语言/主机名/UA 各不相同
 *
 * @param config 档案的指纹策略配置
 * @param index 实例序号（从 1 开始）
 */
export function generateFingerprint(config: FingerprintConfig, index: number): InstanceFingerprint {
  if (!config.enabled) {
    // 未启用指纹隔离时返回空指纹（不影响原有行为）
    return {
      timezone: '',
      language: '',
      locale: '',
      proxy: '',
      hostname: '',
      userAgent: '',
      platform: '',
      hardwareConcurrency: 0,
      deviceMemory: 0,
      screenWidth: 0,
      screenHeight: 0,
      colorDepth: 0,
      webglVendor: '',
      webglRenderer: '',
      canvasSeed: 0,
      audioSeed: 0,
      machineGuid: '',
      hardwareBrand: '',
      hardwareCPU: '',
      hardwareModel: '',
    }
  }

  // 时区：用户池优先，空则按 region 选择内置池；按 index 确定性分配，保证不重复
  const timezone = pickByIndex(config.timezonePool, index, selectTimezonePool(config.region, config.timezonePool))
  // 语言：与时区保持一致的地区
  const language = pickByIndex(config.languagePool, index, selectLanguagePool(config.region, config.languagePool))
  // 代理：用户提供的代理池，按 index 分配（不足时循环复用）
  const proxy = pickByIndex(config.proxyList, index, [])

  // 浏览器层指纹：按 index 确定性分配
  const hardwareConcurrency = pickByIndex([], index, HARDWARE_CONCURRENCY_POOL)
  const deviceMemory = pickByIndex([], index, DEVICE_MEMORY_POOL)
  const [screenWidth, screenHeight] = pickByIndex([], index, SCREEN_RESOLUTIONS)
  const gpu = pickByIndex([], index, WEBGL_GPUS)

  // 硬件信息隔离：按 index 确定性分配品牌+型号和 CPU
  // 服务器通过 DeviceBrand/DeviceModel/DeviceCPU 组合识别物理设备
  const hwBrandModel = pickByIndex([], index, HARDWARE_BRAND_MODELS)
  const hardwareCPU = pickByIndex([], index, HARDWARE_CPUS)

  // Canvas/Audio 随机种子：基于 index 的确定性伪随机，保证同实例每次启动一致、不同实例不同
  const canvasSeed = (index * 7919 + 104729) % 2147483647
  const audioSeed = (index * 65537 + 2654435761) % 2147483647

  return {
    timezone,
    language,
    locale: language,
    proxy,
    hostname: config.generateHostname ? generateHostname(index) : '',
    userAgent: config.customUserAgent || pickByIndex([], index, USER_AGENT_TEMPLATES),
    platform: DEFAULT_PLATFORM,
    hardwareConcurrency,
    deviceMemory,
    screenWidth,
    screenHeight,
    colorDepth: 24,
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    canvasSeed,
    audioSeed,
    machineGuid: generateMachineGuid(),
    hardwareBrand: hwBrandModel.brand,
    hardwareCPU,
    hardwareModel: hwBrandModel.model,
  }
}

/**
 * 生成完全随机的指纹（用于"换指纹"功能）
 * 与 generateFingerprint 不同，此函数每次调用都产生不同的随机指纹
 */
export function generateRandomFingerprint(config: FingerprintConfig): InstanceFingerprint {
  if (!config.enabled) {
    return {
      timezone: '', language: '', locale: '', proxy: '', hostname: '', userAgent: '',
      platform: '', hardwareConcurrency: 0, deviceMemory: 0,
      screenWidth: 0, screenHeight: 0, colorDepth: 0,
      webglVendor: '', webglRenderer: '', canvasSeed: 0, audioSeed: 0,
      machineGuid: '',
      hardwareBrand: '', hardwareCPU: '', hardwareModel: '',
    }
  }

  const timezone = pickRandom(config.timezonePool, selectTimezonePool(config.region, []))
  const language = pickRandom(config.languagePool, selectLanguagePool(config.region, []))
  const proxy = pickRandom(config.proxyList, [])
  const hardwareConcurrency = pickRandom([], HARDWARE_CONCURRENCY_POOL)
  const deviceMemory = pickRandom([], DEVICE_MEMORY_POOL)
  const [screenWidth, screenHeight] = pickRandom([], SCREEN_RESOLUTIONS)
  const gpu = pickRandom([], WEBGL_GPUS)
  const userAgent = config.customUserAgent || pickRandom([], USER_AGENT_TEMPLATES)
  const hwBrandModel = pickRandom([], HARDWARE_BRAND_MODELS)
  const hardwareCPU = pickRandom([], HARDWARE_CPUS)

  // 完全随机的种子
  const canvasSeed = Math.floor(Math.random() * 2147483647)
  const audioSeed = Math.floor(Math.random() * 2147483647)

  return {
    timezone,
    language,
    locale: language,
    proxy,
    hostname: config.generateHostname ? generateHostname(Math.floor(Math.random() * 9999) + 1) : '',
    userAgent,
    platform: DEFAULT_PLATFORM,
    hardwareConcurrency,
    deviceMemory,
    screenWidth,
    screenHeight,
    colorDepth: 24,
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    canvasSeed,
    audioSeed,
    machineGuid: generateMachineGuid(),
    hardwareBrand: hwBrandModel.brand,
    hardwareCPU,
    hardwareModel: hwBrandModel.model,
  }
}

/** 默认指纹配置（未启用） */
export function defaultFingerprintConfig(): FingerprintConfig {
  return {
    enabled: false,
    proxyList: [],
    timezonePool: [], // 空表示用内置默认池（用户无需手动填）
    languagePool: [], // 空表示用内置默认池
    generateHostname: true,
    customUserAgent: '', // 空表示自动分配
    region: 'mixed', // 默认混合（国内+国际），可选 domestic/international
  }
}

/**
 * 将指纹转换为环境变量键值对（用于 CreateProcess 的 env block）
 * 自研引擎使用此函数，比 Sandboxie 的 SetEnvironmentVar 更直接
 */
export function fingerprintToEnvVars(fp: InstanceFingerprint): Record<string, string> {
  const env: Record<string, string> = {}
  if (fp.timezone) {
    env.TZ = fp.timezone
    // hook DLL 注册表 hook 读取：用于隔离 GetTimeZoneInformation()
    env.MULTIOPEN_TZ = fp.timezone
  }
  if (fp.language) {
    env.LANG = fp.language
    env.LANGUAGE = fp.language
    env.LC_ALL = fp.language
    // hook DLL 浏览器重定向用：为重定向浏览器附加 --lang 参数
    env.MULTIOPEN_LANG = fp.language
  }
  if (fp.hostname) {
    env.COMPUTERNAME = fp.hostname
    env.USERDOMAIN = fp.hostname
    // hook DLL 计算机名 hook 读取：用于伪造 GetComputerNameW/GetComputerNameExW 返回值
    // Trae IDE 在 exchangeToken 请求中发送 DeviceName=计算机名，服务器通过此值识别设备
    env.MULTIOPEN_HOSTNAME = fp.hostname
  }
  if (fp.machineGuid) {
    // hook DLL 注册表 hook 读取：用于隔离 HKLM\Cryptography\MachineGuid
    env.MULTIOPEN_MACHINE_GUID = fp.machineGuid
  }
  // 硬件信息隔离：应用在 exchangeToken 请求中发送 DeviceBrand/DeviceCPU/DeviceModel
  // 服务器通过这些硬件组合识别物理设备，不隔离会导致所有实例被识别为同一台机器
  // 应用通过 WMI/注册表读取硬件信息，这里通过环境变量注入伪造值供应用读取
  if (fp.hardwareBrand) {
    env.MULTIOPEN_DEVICE_BRAND = fp.hardwareBrand
  }
  if (fp.hardwareCPU) {
    env.MULTIOPEN_DEVICE_CPU = fp.hardwareCPU
  }
  if (fp.hardwareModel) {
    env.MULTIOPEN_DEVICE_MODEL = fp.hardwareModel
  }
  if (fp.userAgent) {
    env.HTTP_USER_AGENT = fp.userAgent
    // hook DLL 浏览器重定向用：为重定向浏览器附加 --user-agent 参数
    env.MULTIOPEN_USER_AGENT = fp.userAgent
  }
  if (fp.proxy) {
    // Chromium 系应用识别这些环境变量
    env.HTTP_PROXY = fp.proxy
    env.HTTPS_PROXY = fp.proxy
    env.http_proxy = fp.proxy
    env.https_proxy = fp.proxy
    // 禁用 TTNet 的 QUIC 和 HTTP DNS，强制走 Chromium 代理
    // TTNET_QUIC_DISABLE=1 是 TTNet 内部环境变量，禁用 QUIC（UDP 不走代理）
    env.TTNET_QUIC_DISABLE = '1'
    // 本地 OAuth/IPC 回调必须直连。Chromium 对 loopback 有隐式旁路，
    // 这里同时保护遵循 NO_PROXY 的原生模块与 Node/HTTP 客户端。
    env.NO_PROXY = '127.0.0.1,localhost,::1'
    env.no_proxy = env.NO_PROXY
  }
  return env
}

/**
 * 将指纹转换为 Sandboxie ini 配置行
 * 这些行会被 append 到沙箱的 extraIni 中
 */
export function fingerprintToIniLines(fp: InstanceFingerprint): string[] {
  const lines: string[] = []

  if (fp.timezone) {
    lines.push(`SetEnvironmentVar=TZ=${fp.timezone}`)
  }
  if (fp.language) {
    // Windows 和 Linux 的 locale 格式不同，这里同时设置多种格式以兼容
    lines.push(`SetEnvironmentVar=LANG=${fp.language}`)
    lines.push(`SetEnvironmentVar=LANGUAGE=${fp.language}`)
    lines.push(`SetEnvironmentVar=LC_ALL=${fp.language}`)
  }
  if (fp.hostname) {
    lines.push(`SetEnvironmentVar=COMPUTERNAME=${fp.hostname}`)
    lines.push(`SetEnvironmentVar=USERDOMAIN=${fp.hostname}`)
  }
  if (fp.userAgent) {
    // 部分 Chromium 系浏览器通过环境变量覆盖 UA
    lines.push(`SetEnvironmentVar=HTTP_USER_AGENT=${fp.userAgent}`)
  }

  // 代理设置：Sandboxie 原生支持 ProxyServer / ProxyEnable
  if (fp.proxy) {
    const parsed = parseProxyUrl(fp.proxy)
    if (parsed) {
      lines.push(`ProxyServer=${parsed}`)
      lines.push(`ProxyEnable=y`)
    }
  }

  return lines
}

/** 解析代理 URL 为 Sandboxie ProxyServer 格式 */
function parseProxyUrl(url: string): string | null {
  // 支持格式: http://host:port, socks5://host:port, host:port
  const match = url.match(/^(?:(https?|socks[45]?):\/\/)?([^:\/]+):(\d+)/i)
  if (!match) return null

  const [, protocol, host, port] = match
  const proto = (protocol || 'http').toLowerCase()

  if (proto.startsWith('socks')) {
    return `socks=${host}:${port}`
  }
  return `http=${host}:${port};https=${host}:${port}`
}
