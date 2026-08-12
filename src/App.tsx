import { useState } from 'react'
import Workbench from './components/Workbench'
import { cn } from './components/ui'

type Tab = 'workbench' | 'about'

const TABS: { key: Tab; label: string }[] = [
  { key: 'workbench', label: '多开工作台' },
  { key: 'about', label: '关于' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('workbench')

  return (
    <div className="min-h-full">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">应用多开工具</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              独立持久化 Profile + 可审计授权回调
            </p>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-6">
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition',
                  tab === t.key
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 space-y-4">
        {tab === 'workbench' && <Workbench />}
        {tab === 'about' && <AboutPage />}
      </main>

      <footer className="max-w-5xl mx-auto px-6 py-6 text-xs text-slate-400">
        使用说明：选择或新建档案 → 设置新增实例数量 → 开启多开 → 在对应实例中完成登录授权。
      </footer>
    </div>
  )
}

function AboutPage() {
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <h2 className="text-lg font-bold text-slate-900 mb-4">关于本工具</h2>
        <div className="space-y-3 text-sm text-slate-600">
          <div className="flex gap-4">
            <span className="text-slate-400 w-24">版本</span>
            <span>1.0.0</span>
          </div>
          <div className="flex gap-4">
            <span className="text-slate-400 w-24">引擎</span>
            <span>持久化 Profile 隔离引擎（纯用户态，无需安装第三方驱动）</span>
          </div>
          <div className="flex gap-4">
            <span className="text-slate-400 w-24">技术栈</span>
            <span>Electron + React + TypeScript</span>
          </div>
        </div>

        <h3 className="text-sm font-bold text-slate-800 mt-6 mb-3">功能说明</h3>
        <ul className="space-y-2 text-sm text-slate-600 list-disc list-inside">
          <li>多开隔离：每个实例独立工作目录和 Chromium/Electron user-data-dir</li>
          <li>授权代理：验证 loopback 监听归属后，使用实例专属浏览器 Profile 打开当前授权链接</li>
          <li>实例持久化：关闭应用后实例记录保留，除非主动删除</li>
          <li>安全回执：不保存 PKCE、授权码、Cookie 或 Token</li>
        </ul>

        <h3 className="text-sm font-bold text-slate-800 mt-6 mb-3">注意事项</h3>
        <ul className="space-y-2 text-sm text-slate-600 list-disc list-inside">
          <li>本工具使用纯用户态持久化 Profile，不依赖内核驱动</li>
          <li>应用必须支持独立 --user-data-dir；原生全局单例锁不在稳定保证范围内</li>
          <li>一个本机 Profile 不等于一台独立物理设备</li>
          <li>登录或签到只以第三方服务端真实响应为准</li>
        </ul>
      </div>
    </div>
  )
}
