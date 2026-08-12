import { useState, useEffect, useCallback, useRef } from 'react'
import { api, type Profile, type InstanceInfo, type LaunchResult, type AuthorizationReceipt } from '../api'
import { Button, Card, CardBody, SectionTitle, Field, TextInput, Badge, EmptyHint, inputCls, cn } from './ui'

const EMPTY: Omit<Profile, 'id'> = {
  name: '',
  appPath: '',
  appArgs: '',
  workDir: '',
  boxPrefix: 'App',
  openPaths: [],
  defaultCount: 1,
  cleanOnClose: false,
  boxNameTitle: true,
  extraIni: '',
  fingerprint: {
    enabled: false,
    proxyList: [],
    timezonePool: [],
    languagePool: [],
    generateHostname: true,
    customUserAgent: '',
    region: 'mixed',
  },
}

export default function Workbench() {
  // ---- 档案列表 ----
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profileId, setProfileId] = useState(() => localStorage.getItem('im_last_profile') || '')
  const profile = profiles.find((p) => p.id === profileId)

  // ---- 多开操作 ----
  const [count, setCount] = useState(1)
  const [instances, setInstances] = useState<InstanceInfo[]>([])
  const [results, setResults] = useState<LaunchResult[] | null>(null)
  const [launching, setLaunching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [confirmDlg, setConfirmDlg] = useState<{ title: string; onConfirm: () => void } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [resultsCollapsed, setResultsCollapsed] = useState(true)

  // ---- 档案编辑（折叠区） ----
  const [editing, setEditing] = useState<{ id?: string; data: Omit<Profile, 'id'> } | null>(null)

  // ---- 实例授权链路诊断（完整 URL 只在本机内存和本地 API 间传递）----
  const [authDialog, setAuthDialog] = useState<{ box: string; index: number } | null>(null)
  const [authUrl, setAuthUrl] = useState('')
  const [authReceipt, setAuthReceipt] = useState<AuthorizationReceipt | null>(null)
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)

  const _fetching = useRef(false)

  const loadProfiles = useCallback(async () => {
    const r = await api.getProfiles()
    if (!r.ok) {
      setNotice('后端服务未响应，请重启应用')
      return
    }
    const list = r.profiles || []
    setProfiles(list)
    setProfileId((cur) => {
      const saved = localStorage.getItem('im_last_profile')
      if (cur && list.some((p) => p.id === cur)) return cur
      if (saved && list.some((p) => p.id === saved)) return saved
      return list[0]?.id || ''
    })
    setCount((cur) => cur || list[0]?.defaultCount || 1)
  }, [])

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  const onSelectProfile = (id: string) => {
    setProfileId(id)
    localStorage.setItem('im_last_profile', id)
    const p = profiles.find((x) => x.id === id)
    setCount(p?.defaultCount ?? 1)
    setResults(null)
    setSelected(new Set())
    setEditing(null) // 切换档案时收起编辑区
  }

  const refresh = useCallback(async () => {
    if (!profile) return
    if (_fetching.current) return
    _fetching.current = true
    setRefreshing(true)
    const r = await api.getInstances(profile.id, count)
    if (r.ok) {
      setInstances(r.instances || [])
    } else {
      setNotice('刷新失败：' + (r.error || '后端未响应'))
    }
    setRefreshing(false)
    _fetching.current = false
  }, [profile, count])

  useEffect(() => {
    if (profile) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])

  // ---- 启动多开 ----
  const launch = async () => {
    if (!profile) return
    setLaunching(true)
    setResults(null)

    setNotice('正在创建独立工作区并启动实例…')
    const r = await api.launch(profile.id, count, false)
    setLaunching(false)
    if (r.ok) {
      setResults(r.results || [])
      const succeeded = (r.results || []).filter((item) => item.launched).length
      const failed = (r.results || []).length - succeeded
      const firstError = (r.results || []).find((item) => !item.launched)?.error
      setNotice(failed > 0
        ? `启动完成：成功 ${succeeded}，失败 ${failed}。${firstError ? `原因：${firstError}` : '请展开“启动结果”查看原因。'}`
        : `已启动 ${succeeded} 个独立工作区；远端是否识别为独立设备尚未证实。`)
      await refresh()
    } else {
      setNotice('启动失败：' + (r.error || '未知错误'))
    }
  }

  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key)
    try {
      const r = await fn()
      if (r && r.ok === false) {
        const err = r.error || '未知错误'
        if (key.startsWith('m')) {
          setNotice(`删除实例失败：${err}。建议：先点「关闭」停止实例，再点「清空内容」，最后「删除实例」`)
        } else {
          setNotice('操作失败：' + err)
        }
      } else {
        setNotice('')
      }
    } catch (e: any) {
      setNotice('操作异常：' + (e?.message || '未知错误'))
    } finally {
      setBusy('')
    }
    await refresh()
  }

  const stopAll = async () => {
    setBusy('all')
    try {
      for (const ins of instances) {
        if (ins.running) await api.terminate(ins.box)
      }
    } finally {
      setBusy('')
    }
    await refresh()
  }

  const startAll = async () => {
    if (!profile) return
    const stopped = instances.filter((ins) => !ins.running)
    if (stopped.length === 0) return
    setBusy('start-all')
    setNotice(`正在开启 ${stopped.length} 个未运行实例…`)
    let failCount = 0
    try {
      for (const ins of stopped) {
        const r = await api.restart(profile.id, ins.index, false)
        if (!r || r.ok === false) failCount++
      }
    } finally {
      setBusy('')
    }
    setNotice(failCount > 0 ? `全部开启完成，${failCount} 个实例启动失败，请查看实例错误提示` : `已开启 ${stopped.length} 个实例`)
    await refresh()
  }

  const openAuthorizationDialog = (box: string, index: number) => {
    setAuthDialog({ box, index })
    setAuthUrl('')
    setAuthReceipt(null)
    setAuthError('')
  }

  const openInstanceBrowser = async (box: string) => {
    const url = window.prompt('输入要在此实例浏览器中打开的 http/https 链接')
    if (!url?.trim()) return
    const r = await api.openInInstanceBrowser(box, url.trim())
    setNotice(r.ok ? '已在该实例的独立浏览器 Profile 中打开' : (r.error || '实例浏览器启动失败'))
  }

  const runAuthorizationCheck = async (launchBrowser: boolean) => {
    if (!authDialog || !authUrl.trim()) return setAuthError('请粘贴目标实例刚刚生成的授权链接')
    setAuthBusy(true)
    setAuthError('')
    const r = await api.authorization(authDialog.box, authUrl.trim(), launchBrowser)
    setAuthBusy(false)
    if (r.receipt) setAuthReceipt(r.receipt)
    if (!r.ok) setAuthError(r.error || '授权链路检查失败')
  }

  const toggleSelect = (box: string) => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(box)) next.delete(box)
      else next.add(box)
      return next
    })
  }
  const toggleSelectAll = () => {
    if (selected.size === instances.length) setSelected(new Set())
    else setSelected(new Set(instances.map((i) => i.box)))
  }
  const batchDelete = async () => {
    const boxes = Array.from(selected)
    if (boxes.length === 0) return
    setBusy('batch')
    let failCount = 0
    for (const box of boxes) {
      const r = await api.remove(box)
      if (r && r.ok === false) failCount++
    }
    setBusy('')
    setSelected(new Set())
    if (failCount > 0) setNotice(`批量删除完成，${failCount} 个失败（进程可能仍在运行，请先关闭再删除）`)
    await refresh()
  }

  // ---- 档案编辑操作 ----
  const startCreate = () => setEditing({ id: undefined, data: { ...EMPTY } })
  const startEdit = () => {
    if (!profile) return
    setEditing({
      id: profile.id,
              data: {
        name: profile.name,
        appPath: profile.appPath,
        appArgs: profile.appArgs,
        workDir: profile.workDir,
        boxPrefix: profile.boxPrefix,
        openPaths: [...profile.openPaths],
        defaultCount: profile.defaultCount,
        cleanOnClose: profile.cleanOnClose,
        boxNameTitle: profile.boxNameTitle,
        extraIni: profile.extraIni,
        fingerprint: profile.fingerprint
          ? {
              enabled: profile.fingerprint.enabled === true,
              proxyList: [...profile.fingerprint.proxyList],
              timezonePool: [...profile.fingerprint.timezonePool],
              languagePool: [...profile.fingerprint.languagePool],
              generateHostname: profile.fingerprint.generateHostname !== false,
              customUserAgent: profile.fingerprint.customUserAgent || '',
              region: profile.fingerprint.region || 'mixed',
            }
          : { ...EMPTY.fingerprint },
      },
    })
  }

  const del = async (p: Profile) => {
    setConfirmDlg({
      title: `确定删除档案「${p.name}」？此操作不会清除已创建的沙箱内容`,
      onConfirm: async () => {
        const r = await api.deleteProfile(p.id)
        if (!r.ok) { setNotice('删除失败：' + (r.error || '未知错误')); return }
        if (profileId === p.id) { setProfileId(''); localStorage.removeItem('im_last_profile') }
        await loadProfiles()
      },
    })
  }

  const saveProfile = async () => {
    if (!editing) return
    const d = editing.data
    if (!d.name.trim()) return setNotice('请填写档案名称')
    if (!d.appPath.trim()) return setNotice('请选择目标程序')
    const r = editing.id ? await api.updateProfile(editing.id, d) : await api.createProfile(d)
    if (!r.ok) return setNotice('保存失败：' + (r.error || '未知错误'))
    setEditing(null)
    await loadProfiles()
  }

  return (
    <div className="space-y-4">
      {/* ===== 顶部操作区 ===== */}
      <Card>
        <CardBody>
          <SectionTitle
            title="多开工作台"
            desc="每个实例使用独立工作目录、应用 Profile 和浏览器 Profile；不伪装成新的物理设备。"
            right={
              <div className="flex gap-2">
                <Button variant="subtle" className="!py-1.5 !px-3 text-xs" onClick={startEdit} disabled={!profile}>
                  编辑档案
                </Button>
                <Button variant="subtle" className="!py-1.5 !px-3 text-xs" onClick={startCreate}>
                  + 新建档案
                </Button>
                {profile && (
                  <Button variant="danger" className="!py-1.5 !px-3 text-xs" onClick={() => del(profile)}>
                    删除
                  </Button>
                )}
              </div>
            }
          />

          <div className="grid gap-4 md:grid-cols-3 items-end">
            <div className="md:col-span-1">
              <Field label="选择档案">
                <select
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  value={profileId}
                  onChange={(e) => onSelectProfile(e.target.value)}
                >
                  {profiles.length === 0 && <option value="">（无档案，请新建）</option>}
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="多开数量">
              <TextInput
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              />
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="primary" className="flex-1" loading={launching} onClick={launch} disabled={!profile}>
                开启多开
              </Button>
              <Button variant="subtle" loading={refreshing} onClick={refresh} disabled={!profile}>
                {refreshing ? '刷新中...' : '刷新状态'}
              </Button>
            </div>
          </div>

          {notice && (
            <div className="mt-4 rounded-lg bg-brand-50 border border-brand-100 px-4 py-3 text-sm text-brand-700">
              {notice}
            </div>
          )}

          {profile && (
            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              {profile.openPaths.length > 0 && (
                <span>
                  共享目录：
                  {profile.openPaths.map((p, i) => (
                    <code key={i} className="ml-1 bg-slate-100 px-1.5 py-0.5 rounded">
                      {p}
                    </code>
                  ))}
                </span>
              )}
              <Badge tone="blue">稳定隔离：工作区 + 应用 Profile + 浏览器 Profile</Badge>
            </div>
          )}
        </CardBody>
      </Card>

      {/* ===== 实例列表 ===== */}
      <Card>
        <CardBody>
          <SectionTitle
            title={`实例列表（共 ${instances.length} 个）`}
            right={
              <div className="flex gap-2">
                {selected.size > 0 && (
                  <Button
                    variant="danger"
                    loading={busy === 'batch'}
                    onClick={() => {
                      setConfirmDlg({
                        title: `确定批量删除选中的 ${selected.size} 个实例？将同时移除沙箱配置和持久化记录`,
                        onConfirm: batchDelete,
                      })
                    }}
                  >
                    批量删除（{selected.size}）
                  </Button>
                )}
                <Button variant="primary" loading={busy === 'start-all'} onClick={startAll} disabled={!instances.some((i) => !i.running) || launching}>
                  全部开启
                </Button>
                <Button variant="danger" loading={busy === 'all'} onClick={stopAll} disabled={!instances.some((i) => i.running)}>
                  全部关闭
                </Button>
              </div>
            }
          />
          {instances.length === 0 && <EmptyHint>暂无实例，开启多开或点击「刷新状态」查看</EmptyHint>}
          {instances.length > 0 && (
            <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
              <input type="checkbox" checked={selected.size === instances.length} onChange={toggleSelectAll} className="rounded border-slate-300" />
              <span>全选（{selected.size}/{instances.length}）</span>
              <span className="ml-3 text-slate-400">运行中实例显示黄色边框</span>
            </div>
          )}
          <div className="space-y-2">
            {instances.map((ins) => {
              const borderClass = ins.running
                ? 'border-2 border-yellow-400 shadow-sm'
                : 'border-2 border-slate-200 hover:border-yellow-400 hover:shadow-sm'
              return (
                <div key={ins.index} className={`flex flex-wrap items-center justify-between gap-3 rounded-lg ${borderClass} px-4 py-3 transition-colors`}>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <input type="checkbox" checked={selected.has(ins.box)} onChange={() => toggleSelect(ins.box)} className="rounded border-slate-300" />
                      <span className="font-medium text-slate-700">#{ins.index}</span>
                      <code className="text-xs bg-slate-100 px-2 py-1 rounded">{ins.box}</code>
                      {ins.running ? <Badge tone="green">运行中 · {ins.pidCount} 进程</Badge> : <Badge tone="slate">未运行</Badge>}
                      {ins.name && <span className="text-xs text-slate-400">{ins.name}</span>}
                    </div>
                    <div className="text-xs text-slate-400">独立工作区 · 独立 config · 独立 browser-profile-v2</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="subtle" className="!py-1 !px-2.5 text-xs" disabled={!ins.running} onClick={() => openAuthorizationDialog(ins.box, ins.index)}>
                      授权链路
                    </Button>
                    <Button variant="subtle" className="!py-1 !px-2.5 text-xs" disabled={!ins.running} onClick={() => openInstanceBrowser(ins.box)}>
                      实例浏览器
                    </Button>
                    <Button
                      variant="subtle"
                      className="!py-1 !px-2.5 text-xs"
                      loading={busy === `r${ins.index}`}
                      disabled={launching}
                      onClick={() => act(`r${ins.index}`, () => (profile ? api.restart(profile.id, ins.index, false) : Promise.resolve()))}
                    >
                      重启
                    </Button>
                    <Button variant="subtle" className="!py-1 !px-2.5 text-xs" loading={busy === `t${ins.index}`} disabled={launching} onClick={() => act(`t${ins.index}`, () => api.terminate(ins.box))}>
                      关闭
                    </Button>
                    <Button
                      variant="subtle"
                      className="!py-1 !px-2.5 text-xs"
                      loading={busy === `c${ins.index}`}
                      disabled={launching}
                      onClick={() => {
                        setConfirmDlg({
                          title: '确定清空此沙箱内容？将删除沙箱内所有非共享文件（登录态/Cookie等），共享真实目录不受影响',
                          onConfirm: () => act(`c${ins.index}`, () => api.clean(ins.box)),
                        })
                      }}
                    >
                      清空内容
                    </Button>
                    <Button
                      variant="danger"
                      className="!py-1 !px-2.5 text-xs"
                      loading={busy === `m${ins.index}`}
                      disabled={launching}
                      onClick={() => {
                        setConfirmDlg({
                          title: '确定删除此实例？将同时移除沙箱配置和持久化记录',
                          onConfirm: () => act(`m${ins.index}`, () => api.remove(ins.box)),
                        })
                      }}
                    >
                      删除实例
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </CardBody>
      </Card>

      {/* ===== 启动结果（折叠） ===== */}
      {results && (
        <Card>
          <CardBody>
            <button className="flex w-full items-center justify-between text-left" onClick={() => setResultsCollapsed((c) => !c)}>
              <SectionTitle title={`启动结果（${results.length} 个）`} />
              <span className="text-xs text-slate-400 ml-2">{resultsCollapsed ? '展开 ▸' : '收起 ▾'}</span>
            </button>
            {!resultsCollapsed && (
              <div className="space-y-1.5 mt-3">
                {results.map((r) => (
                  <div key={r.index} className="flex items-center justify-between text-sm">
                    <span>
                      #{r.index} <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{r.box}</code>
                    </span>
                    {r.launched ? <Badge tone="green">已启动</Badge> : <Badge tone="red">失败：{r.error}</Badge>}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* ===== 档案配置（可折叠） ===== */}
      {editing && (
        <ProfileForm
          key={editing.id || 'new'}
          editing={editing}
          onChange={(data) => setEditing({ ...editing, data })}
          onClose={() => setEditing(null)}
          onSave={saveProfile}
        />
      )}

      {/* ===== 授权链路诊断 ===== */}
      {authDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">实例 #{authDialog.index} 授权链路</h3>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              请只使用该运行实例刚刚生成的链接。工具会先确认 127.0.0.1 回调端口由该实例持有，再用实例专属浏览器 Profile 打开；完整链接、授权码和 PKCE 参数不会写入日志。
            </p>
            <textarea
              className={cn(inputCls, 'mt-4 h-28 font-mono text-xs')}
              value={authUrl}
              onChange={(e) => setAuthUrl(e.target.value)}
              placeholder="https://.../authorization?...&auth_callback_url=http://127.0.0.1:端口/authorize"
            />
            {authError && <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{authError}</div>}
            {authReceipt && <AuthorizationReceiptView receipt={authReceipt} />}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setAuthDialog(null)}>关闭</Button>
              <Button variant="subtle" loading={authBusy} onClick={() => runAuthorizationCheck(false)}>仅检查</Button>
              <Button variant="primary" loading={authBusy} onClick={() => runAuthorizationCheck(true)}>检查并用实例浏览器打开</Button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 确认对话框 ===== */}
      {confirmDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 max-w-md rounded-lg bg-white p-6 shadow-xl">
            <p className="text-sm text-slate-700">{confirmDlg.title}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="subtle" onClick={() => setConfirmDlg(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const fn = confirmDlg.onConfirm
                  setConfirmDlg(null)
                  fn()
                }}
              >
                确定
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AuthorizationReceiptView({ receipt }: { receipt: AuthorizationReceipt }) {
  const ok = receipt.status === 'inspected' || receipt.status === 'launch-dispatched'
  return (
    <div className={cn('mt-3 rounded border px-3 py-3 text-xs', ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800')}>
      <div className="font-medium">状态：{receipt.status}{receipt.reason ? ` · ${receipt.reason}` : ''}</div>
      <div className="mt-2 grid gap-1 sm:grid-cols-2">
        <span>授权站点：{receipt.authorizationHost}{receipt.authorizationPath}</span>
        <span>回调：{receipt.callbackHost}:{receipt.callbackPort}{receipt.callbackPath}</span>
        <span>监听 PID：{receipt.listenerPid || '未监听'}</span>
        <span>归属实例：{receipt.listenerOwnedByInstance ? '是' : '否/未知'}</span>
        <span>实例主 PID：{receipt.instanceMainPid || '未运行'}</span>
        <span>浏览器 PID：{receipt.browserPid || '尚未启动'}</span>
      </div>
    </div>
  )
}

// ===== 档案编辑表单 =====
function ProfileForm({
  editing,
  onChange,
  onClose,
  onSave,
}: {
  editing: { id?: string; data: Omit<Profile, 'id'> }
  onChange: (d: Omit<Profile, 'id'>) => void
  onClose: () => void
  onSave: () => void
}) {
  const d = editing.data
  const dataRef = useRef(d)
  dataRef.current = d
  const set = <K extends keyof Omit<Profile, 'id'>>(k: K, v: Omit<Profile, 'id'>[K]) =>
    onChange({ ...dataRef.current, [k]: v })
  const [picking, setPicking] = useState<string>('')

  const pick = async (kind: 'folder' | 'file', title: string, target: 'appPath' | 'workDir') => {
    setPicking(target)
    const r = await api.pick(kind, title)
    setPicking('')
    if (r.ok && r.path) set(target, r.path)
  }

  const pickOpenPath = async () => {
    setPicking('open')
    const r = await api.pick('folder', '选择要共享的真实数据文件夹')
    setPicking('')
    if (r.ok && r.path) set('openPaths', [...d.openPaths, r.path])
  }

  return (
    <Card className="border-brand-200">
      <CardBody>
        <SectionTitle title={editing.id ? '编辑档案' : '新建档案'} desc="带 * 为必填项。保存后点击「收起」可折叠此区域" />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="档案名称 *">
            <TextInput value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="例如：浏览器多开" />
          </Field>
          <Field label="默认多开数量" hint="1 ~ 50">
            <TextInput type="number" min={1} max={50} value={d.defaultCount} onChange={(e) => set('defaultCount', Number(e.target.value) || 1)} />
          </Field>

          <div className="md:col-span-2">
            <Field label="目标程序路径 *" hint="要多开的应用程序 exe 完整路径（必须位于主机真实磁盘）">
              <div className="flex gap-2">
                <TextInput value={d.appPath} onChange={(e) => set('appPath', e.target.value)} placeholder="C:\App\app.exe" />
                <Button variant="subtle" loading={picking === 'appPath'} onClick={() => pick('file', '选择目标程序', 'appPath')}>
                  选择
                </Button>
              </div>
            </Field>
          </div>

          <Field label="启动参数（可选）">
            <TextInput value={d.appArgs} onChange={(e) => set('appArgs', e.target.value)} placeholder="留空" />
          </Field>
          <Field label="工作目录（可选）" hint="留空则取程序所在目录">
            <div className="flex gap-2">
              <TextInput value={d.workDir} onChange={(e) => set('workDir', e.target.value)} placeholder="留空" />
              <Button variant="subtle" loading={picking === 'workDir'} onClick={() => pick('folder', '选择工作目录', 'workDir')}>
                选择
              </Button>
            </div>
          </Field>

          <Field label="沙箱名前缀" hint="实例沙箱名为 前缀-编号，仅字母数字下划线">
            <TextInput value={d.boxPrefix} onChange={(e) => set('boxPrefix', e.target.value)} placeholder="App" />
          </Field>
          <div className="flex items-end gap-6 pb-1">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="h-4 w-4" checked={d.boxNameTitle} onChange={(e) => set('boxNameTitle', e.target.checked)} />
              窗口标题显示沙箱名
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" className="h-4 w-4" checked={d.cleanOnClose} onChange={(e) => set('cleanOnClose', e.target.checked)} />
              关闭时清空沙箱内容
            </label>
          </div>

          <div className="md:col-span-2">
            <Field label="共享的真实数据文件夹" hint="所有实例通过 Junction 直通主机这些文件夹，共同读写同一份真实数据">
              <div className="space-y-2">
                {d.openPaths.length === 0 && <div className="text-xs text-slate-400">尚未添加任何真实文件夹</div>}
                {d.openPaths.map((p, i) => (
                  <div key={i} className="flex gap-2">
                    <TextInput value={p} onChange={(e) => { const next = [...d.openPaths]; next[i] = e.target.value; set('openPaths', next) }} />
                    <Button variant="danger" className="!py-2 !px-2.5" onClick={() => set('openPaths', d.openPaths.filter((_, j) => j !== i))}>
                      ✕
                    </Button>
                  </div>
                ))}
                <Button variant="subtle" loading={picking === 'open'} onClick={pickOpenPath}>
                  + 添加文件夹
                </Button>
              </div>
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field label="高级：额外沙箱配置（可选）" hint="每行一条，格式 Key=Value">
              <textarea
                className={cn(inputCls, 'font-mono h-20')}
                value={d.extraIni}
                onChange={(e) => set('extraIni', e.target.value)}
                placeholder="OpenKeyPath=HKEY_CURRENT_USER\Software\MyApp"
              />
            </Field>
          </div>

          {/* 支持边界 */}
          <div className="md:col-span-2 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
            <div className="text-sm font-medium text-slate-800">实例隔离边界</div>
            <div className="mt-1 text-xs leading-5 text-slate-500">
              支持独立工作目录、应用 Profile 和浏览器 Profile。设备指纹轮换、系统用户目录改写、原生全局 Hook 与自动免费代理已退出稳定路径：它们不能把进程实例变成新的物理设备，并可能破坏启动或登录回调。
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            收起
          </Button>
          <Button variant="primary" onClick={onSave}>
            保存档案
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
