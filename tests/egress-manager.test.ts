import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTrustedEgress, verifyTrustedEgress } from '../server/egress-manager.js'

test('可信出口解析只接受无凭据的 http/https CONNECT 地址', () => {
  assert.deepEqual(parseTrustedEgress('https://proxy.example:8443'), {
    protocol: 'https:', host: 'proxy.example', port: 8443, endpoint: 'https://proxy.example:8443',
  })
  assert.throws(() => parseTrustedEgress('http://user:pass@proxy.example:8080'), /不得包含账号、密码/)
  assert.throws(() => parseTrustedEgress('socks5://proxy.example:1080'), /仅支持 http\/https/)
  assert.throws(() => parseTrustedEgress('https://proxy.example:8443/path'), /只能包含协议/)
})

test('可信出口验证对非法配置闭锁且不建立请求', async () => {
  const result = await verifyTrustedEgress('http://user:pass@proxy.example:8080')
  assert.equal(result.verified, false)
  assert.match(result.error || '', /不得包含账号、密码/)
})
