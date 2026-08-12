import WebSocket from 'ws'

const cdpPort = Number(process.env.MULTIOPEN_CDP_PORT || 9333)
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json())
const pages = targets.filter((target) => target.type === 'page' && target.url === 'http://127.0.0.1:17890/')
if (pages.length !== 1) throw new Error(`Expected one multiopen page, found ${pages.length}`)

const socket = new WebSocket(pages[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})
let nextId = 1
const pending = new Map()
socket.on('message', (data) => {
  const message = JSON.parse(String(data))
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
})

function call(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed')
  return result.result?.value
}

const summary = await evaluate(`(async () => {
  const token = await window.electronAPI?.getApiToken?.();
  const response = await fetch('/api/profiles', { headers: { Authorization: 'Bearer ' + token } });
  const payload = await response.json();
  const profiles = payload.profiles || [];
  const trae = profiles.find((profile) => /TraeWork/i.test(profile.name));
  if (trae) {
    const select = document.querySelector('select');
    select.value = trae.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  const traeInstances = trae
    ? await fetch('/api/profiles/' + trae.id + '/instances?count=50', {
        headers: { Authorization: 'Bearer ' + token },
      }).then((item) => item.json())
    : { instances: [] };
  const text = document.body.innerText;
  return {
    title: document.title,
    rootChildren: document.getElementById('root')?.childElementCount || 0,
    apiOk: response.ok && payload.ok === true,
    profileCount: profiles.length,
    selectedTrae: !!trae,
    stableBoundaryVisible: text.includes('稳定隔离：工作区 + 应用 Profile + 浏览器 Profile'),
    unsupportedDeviceClaimAbsent: !text.includes('每个实例使用独立IP'),
    authorizationActionVisible: text.includes('授权链路'),
    traeRunningCount: (traeInstances.instances || []).filter((item) => item.running).length,
  };
})()`)

if (process.env.MULTIOPEN_SMOKE_RESTART_TRAE === '1') {
  summary.traeStart = await evaluate(`(async () => {
    const token = await window.electronAPI?.getApiToken?.();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const profiles = await fetch('/api/profiles', { headers }).then((response) => response.json());
    const trae = (profiles.profiles || []).find((profile) => /TraeWork/i.test(profile.name));
    if (!trae) return { ok: false, error: 'TraeWork profile not found' };
    const before = await fetch('/api/profiles/' + trae.id + '/instances?count=1', { headers }).then((response) => response.json());
    const existing = (before.instances || []).sort((a, b) => a.index - b.index)[0];
    if (!existing) return { ok: false, error: 'TraeWork instance not found' };
    const restart = await fetch('/api/profiles/' + trae.id + '/restart', {
      method: 'POST', headers, body: JSON.stringify({ index: existing.index, fingerprintEnabled: false }),
    }).then((response) => response.json());
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await fetch('/api/profiles/' + trae.id + '/instances?count=1', { headers }).then((response) => response.json());
    const instance = (after.instances || []).find((item) => item.index === existing.index);
    return {
      ok: restart.ok === true,
      running: instance?.running === true,
      pidCount: instance?.pidCount || 0,
      box: existing.box,
      error: restart.error || null,
    };
  })()`)
}

if (process.env.MULTIOPEN_SMOKE_ADD_TRAE === '1') {
  summary.traeAdd = await evaluate(`(async () => {
    const token = await window.electronAPI?.getApiToken?.();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const profiles = await fetch('/api/profiles', { headers }).then((response) => response.json());
    const trae = (profiles.profiles || []).find((profile) => /TraeWork/i.test(profile.name));
    if (!trae) return { ok: false, error: 'TraeWork profile not found' };
    const launched = await fetch('/api/profiles/' + trae.id + '/launch', {
      method: 'POST', headers, body: JSON.stringify({ count: 1 }),
    }).then((response) => response.json());
    const result = (launched.results || [])[0];
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const after = await fetch('/api/profiles/' + trae.id + '/instances?count=2', { headers }).then((response) => response.json());
    const instance = (after.instances || []).find((item) => item.index === result?.index);
    return {
      ok: launched.ok === true && result?.launched === true,
      index: result?.index || 0,
      running: instance?.running === true,
      pidCount: instance?.pidCount || 0,
      totalRunning: (after.instances || []).filter((item) => item.running).length,
      error: result?.error || null,
    };
  })()`)
}

if (process.env.MULTIOPEN_SMOKE_AUTH_FAIL_CLOSED === '1') {
  summary.authorizationFailClosed = await evaluate(`(async () => {
    const token = await window.electronAPI?.getApiToken?.();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const secret = 'VERY_SECRET_PKCE_VALUE_MUST_NOT_PERSIST';
    const url = 'https://www.trae.cn/authorization?client_id=smoke-client&auth_callback_url=' +
      encodeURIComponent('http://127.0.0.1:65534/authorize') + '&code_challenge=' + secret +
      '&code_challenge_method=S256';
    const response = await fetch('/api/instances/' + encodeURIComponent('TraeWork-1') + '/authorization', {
      method: 'POST', headers, body: JSON.stringify({ url, launch: true }),
    });
    const payload = await response.json();
    const receipts = await fetch('/api/instances/' + encodeURIComponent('TraeWork-1') + '/authorization-receipts', {
      headers,
    }).then((item) => item.json());
    return {
      blocked: response.status === 409 && payload.ok === false,
      status: payload.receipt?.status || '',
      reason: payload.receipt?.reason || '',
      callbackPort: payload.receipt?.callbackPort || 0,
      secretAbsentFromResponse: !JSON.stringify(payload).includes(secret),
      secretAbsentFromReceipts: !JSON.stringify(receipts).includes(secret),
    };
  })()`)
}

if (process.env.MULTIOPEN_SMOKE_STOP_TRAE === '1') {
  summary.traeStop = await evaluate(`(async () => {
    const token = await window.electronAPI?.getApiToken?.();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const profiles = await fetch('/api/profiles', { headers }).then((response) => response.json());
    const trae = (profiles.profiles || []).find((profile) => /TraeWork/i.test(profile.name));
    if (!trae) return { ok: false, error: 'TraeWork profile not found' };
    const instances = await fetch('/api/profiles/' + trae.id + '/instances?count=1', { headers }).then((response) => response.json());
    const existing = (instances.instances || []).sort((a, b) => a.index - b.index)[0];
    if (!existing) return { ok: false, error: 'TraeWork instance not found' };
    const stopped = await fetch('/api/instances/' + encodeURIComponent(existing.box) + '/terminate', {
      method: 'POST', headers,
    }).then((response) => response.json());
    return { ok: stopped.ok === true, box: existing.box, error: stopped.error || null };
  })()`)
}

socket.terminate()
process.stdout.write(JSON.stringify(summary, null, 2) + '\n', () => process.exit(0))
