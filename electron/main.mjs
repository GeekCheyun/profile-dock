// Electron 主进程：内嵌编译后的后端（Express）在主进程内启动，并用桌面窗口加载其 UI。
import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 固化 GPU 禁用：部分运行环境（虚拟显卡 / 无 GPU 的远程或沙箱会话）没有可用 GPU 进程，
// 不禁用时 Electron 会因 "GPU process isn't usable" 直接 FATAL 退出。
// 注意：本机会强制走软件渲染（性能略降但功能正常）。如在本机希望恢复硬件加速，可移除下面三行。
// Hardware acceleration is enabled by default. Set MULTIOPEN_DISABLE_GPU=1
// only for machines with a known GPU-process crash; forcing software
// rendering here made the manager and all rendered pages noticeably slow.
if (process.env.MULTIOPEN_DISABLE_GPU === '1') {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-software-rasterizer')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 设置应用用户模型 ID：让 Windows 任务栏按本应用分组、显示 electron 默认图标。
app.setAppUserModelId('com.workbuddy.multi-open-tool')
// 统一使用 127.0.0.1（IPv4），避免 localhost 在 Node(Vite) 与 Chromium 之间 IPv4/IPv6 解析不一致导致白屏。
// 仅当显式设置了 VITE_DEV_SERVER_URL（即 dev 模式，dev server 确实在运行）时才走 dev URL；
// 否则（生产模式，双击 .bat/.vbs 直接 `electron .` 未设置该变量）使用后端 Express 提供的打包前端地址，
// 否则会去连一个未启动的 5173 而整窗白屏。
const DEV_URL = process.env.VITE_DEV_SERVER_URL
  ? process.env.VITE_DEV_SERVER_URL.replace(/localhost/i, '127.0.0.1')
  : 'http://127.0.0.1:17890'

let win
const API_TOKEN = crypto.randomBytes(32).toString('hex')
process.env.MULTIOPEN_API_TOKEN = API_TOKEN

// 加载失败时显示的错误页（替代白屏，给用户明确反馈）
const ERROR_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>启动失败</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;background:#f1f5f9;color:#334155;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:40px;max-width:500px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h2{color:#dc2626;margin:0 0 16px;font-size:20px}
p{color:#64748b;line-height:1.7;margin:6px 0;font-size:14px}
.hint{margin-top:18px;color:#94a3b8;font-size:12px}</style></head>
<body><div class="card"><h2>应用启动失败</h2>
<p id="msg">无法连接后端服务。</p>
<p><b>可能原因：</b></p>
<p>1. 应用已在运行 — 请切换到已有窗口，或先关闭它</p>
<p>2. 端口 17890 被其他程序占用</p>
<p>3. 后端构建产物缺失 — 请用「多开工具.bat」重新初始化</p>
<p class="hint">关闭此窗口后重新双击图标启动</p>
</div></body></html>`

// 后端刚启动时可能还没监听，做带重试的加载。返回是否成功。
async function loadWithRetry(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      await win.loadURL(url)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  try {
    await win.loadURL(url)
    return true
  } catch {
    return false
  }
}

function showErrorPage(detail) {
  if (!win) return
  const html = ERROR_HTML.replace('无法连接后端服务。', detail)
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// 高完整性（管理员）进程无法连接 Windows TSF 输入法、剪贴板等中完整性服务，
// 也会拖慢 WorkBuddy 的认证/网络服务。启动时检测一次并给出明确提示，
// 不阻塞窗口创建（fire-and-forget）。
// 高完整性（管理员）进程无法连接 Windows TSF 输入法，实例输入法必然失效。
// 无论用户通过哪种方式启动（包括右键“以管理员身份运行”），只要检测到提权，
// 就自动以普通权限重启一次再退出，保证实例永远运行在普通权限。
async function relaunchIfElevated() {
  if (process.platform !== 'win32') return false
  const elevated = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive',
        '-Command',
        '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)',
      ],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => resolve(!err && /^true\s*$/im.test(stdout || ''))
    )
  })
  if (!elevated) return false

  console.warn('[多开工具] 检测到管理员权限，自动以普通权限重启（否则实例无法使用输入法）。')
  const appDir = path.join(__dirname, '..')
  const exe = process.execPath
  // 通过 explorer.exe 启动：explorer 运行在普通用户完整性级别，
  // 由它派生的进程不带管理员令牌。参数加引号避免路径空格问题。
  const child = spawn('explorer.exe', [`"${exe}"`, `"${appDir}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  setTimeout(() => app.exit(0), 800)
  return true
}

// 检测端口是否可连接（用于判断是否已有实例在运行）
function isPortReachable(port) {
  return new Promise((resolve) => {
    const tester = net.connect({ port, host: '127.0.0.1' })
    tester.once('connect', () => { tester.destroy(); resolve(true) })
    tester.once('error', () => resolve(false))
    setTimeout(() => { tester.destroy(); resolve(false) }, 800)
  })
}

async function bootstrap() {
  // 数据目录指向 userData，避免打包后写入 Program Files
  process.env.MULTIOPEN_DATA_DIR = app.getPath('userData')
  process.env.ELECTRON_DESKTOP = '1'

  if (await relaunchIfElevated()) return

  // 端口检测（仅生产模式）：如果端口已在监听，说明已有实例运行。
  // 不用 Electron 单实例锁（requestSingleInstanceLock），因为它在异常退出后锁残留
  // 会导致下次启动 lock 失败、app.quit() 直接退出、窗口不出现 —— 这是白屏的根因。
  if (!process.env.VITE_DEV_SERVER_URL) {
    const inUse = await isPortReachable(17890)
    if (inUse) {
      dialog.showErrorBox(
        '应用多开工具',
        '应用已在运行，请切换到已有窗口。\n\n如果未看到窗口，请通过任务管理器结束所有 electron 进程后重试。'
      )
      app.quit()
      return
    }
  }

  // 监听后端端口冲突（由 dist-server/index.js 通过 process.emit 通知）
  process.on('backend-listen-error', (msg) => {
    console.error('[多开工具] 后端监听失败:', msg)
    dialog.showErrorBox(
      '应用多开工具 - 后端启动失败',
      msg + '\n\n可能原因：\n1. 应用已在运行（请关闭已有实例后重试）\n2. 端口 17890 被其他程序占用'
    )
  })

  // 内置后端（编译后的 ESM）在主进程内启动。动态 import 在 Windows 上需 file:// URL。
  try {
    const serverUrl = pathToFileURL(path.join(__dirname, '..', 'dist-server', 'index.js')).href
    await import(serverUrl)
  } catch (e) {
    console.error('[多开工具] 后端加载失败:', e)
    dialog.showErrorBox(
      '应用多开工具',
      '后端加载失败：' + (e?.message || e) + '\n\n请用「多开工具.bat」重新初始化构建。'
    )
  }

  // 自研引擎无需初始化（纯用户态，始终就绪）

  Menu.setApplicationMenu(null)
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: '应用多开工具',
    autoHideMenuBar: true,
    backgroundColor: '#f1f5f9',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  // 诊断日志：定位白屏 / 加载失败 / 渲染是否真的挂载
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[多开工具] 页面加载失败 ${code} ${desc} @ ${url}`)
  })
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[renderer:${level}] ${message}`)
  })
  win.webContents.on('did-finish-load', async () => {
    console.log('[多开工具] 页面加载完成')
    try {
      const count = await win.webContents.executeJavaScript(
        "document.getElementById('root') ? document.getElementById('root').childElementCount : -1"
      )
      console.log(`[多开工具] #root 子节点数: ${count}${count > 0 ? ' (React 已挂载，非白屏)' : ' (空白！)'}`)
    } catch {}
  })

  const url = DEV_URL || 'http://127.0.0.1:17890'
  const ok = await loadWithRetry(url)
  if (!ok) {
    // 加载失败：显示错误页而非白屏，给用户明确的诊断信息
    showErrorPage('无法连接后端服务 http://127.0.0.1:17890（端口可能被占用或后端未启动）。')
  }
}

// ---- 原生路径选择对话框（preload + ipcMain 通道）----
// 渲染进程通过 window.electronAPI.pick() 触发，由主进程确定性地弹出原生 dialog，
// 彻底去掉"在 HTTP 处理器里猜测主进程环境 + 动态 import('electron')"的不确定性。
ipcMain.handle('dialog:pick', async (_e, { kind, title }) => {
  const parentWin =
    BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || undefined
  const opts = {
    title: title || '请选择',
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
    filters: kind === 'file' ? [{ name: '程序', extensions: ['exe'] }] : [],
  }
  try {
    const result = parentWin
      ? await dialog.showOpenDialog(parentWin, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths?.length) {
      return { path: '', cancelled: true }
    }
    return { path: result.filePaths[0], cancelled: false }
  } catch (err) {
    console.error('[多开工具][ipc pick] 对话框失败:', err)
    return { path: '', cancelled: true }
  }
})

// Bearer token is delivered only through the isolated preload bridge. The
// production HTTP service does not expose a token-retrieval endpoint.
ipcMain.handle('api:get-token', () => API_TOKEN)

// 不使用 Electron 单实例锁（requestSingleInstanceLock）：它在异常退出后锁残留会导致
// 下次启动 lock 失败、直接 quit、窗口不出现（白屏根因）。改用端口检测（见 bootstrap）。
app.whenReady().then(bootstrap)
app.on('window-all-closed', () => app.quit())
