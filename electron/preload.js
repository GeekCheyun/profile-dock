// Electron 预加载脚本（preload）
//
// 运行于「隔离世界」（sandbox: true + contextIsolation: true），无法直接访问 Node / 渲染进程全局，
// 只能通过 contextBridge 向 window 暴露一个最小且安全的 API。
//
// 关键能力：把"选择路径"的请求转发给主进程的原生对话框（dialog:pick 通道），
// 彻底替代原先"在 HTTP 路由里猜测主进程环境并动态 import('electron') 调 dialog"的不确定实现。
//
// 注意：sandbox: true 下预加载脚本以 CommonJS 形式运行，不支持 ESM import，
// 必须用 require（仅 electron 模块可用）。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getApiToken: () => ipcRenderer.invoke('api:get-token'),
  /**
   * 在渲染进程中调用：await window.electronAPI.pick('folder' | 'file', title)
   * 由主进程确定性地弹出原生文件/文件夹选择对话框。
   * @param kind  'folder' 选择目录 | 'file' 选择文件
   * @param title 对话框标题
   * @returns { path: string, cancelled: boolean }
   */
  pick: (kind, title) => ipcRenderer.invoke('dialog:pick', { kind, title }),
})
