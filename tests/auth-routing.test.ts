import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  LOOPBACK_NO_PROXY,
  buildAuthorizationBrowserArgs,
  parseAuthorizationTarget,
} from '../server/auth-routing.js'

const callback = 'http://127.0.0.1:62687/authorize'
const longChallenge = 'x'.repeat(2048)
const authorizationUrl = new URL('https://example.test/authorization')
authorizationUrl.searchParams.set('client_id', 'desktop-test')
authorizationUrl.searchParams.set('auth_callback_url', callback)
authorizationUrl.searchParams.set('code_challenge', longChallenge)
authorizationUrl.searchParams.set('state', 'a&b=c')

test('parses a long PKCE authorization URL without retaining query values', () => {
  const target = parseAuthorizationTarget(authorizationUrl.href)
  assert.equal(target.authorizationHost, 'example.test')
  assert.equal(target.authorizationPath, '/authorization')
  assert.equal(target.callbackHost, '127.0.0.1')
  assert.equal(target.callbackPort, 62687)
  assert.equal(target.callbackPath, '/authorize')
  assert.deepEqual(target.authorizationQueryKeys, [
    'auth_callback_url',
    'client_id',
    'code_challenge',
    'state',
  ])
  assert.equal(JSON.stringify(target).includes(longChallenge), false)
})

test('browser arguments preserve the authorization URL exactly and never subtract loopback bypass', () => {
  const args = buildAuthorizationBrowserArgs(
    authorizationUrl.href,
    'D:\\instances\\one\\browser-profile-v2',
    'http://proxy.test:8080',
  )
  assert.equal(args.at(-1), authorizationUrl.href)
  assert.equal(args.filter((value) => value === authorizationUrl.href).length, 1)
  assert.ok(args.includes('--proxy-server=http://proxy.test:8080'))
  assert.equal(args.some((value) => value.includes('<-loopback>')), false)
  assert.equal(LOOPBACK_NO_PROXY, '127.0.0.1,localhost,::1')
})

test('rejects non-loopback callbacks and non-HTTPS authorization entries', () => {
  assert.throws(
    () => parseAuthorizationTarget('https://example.test/authorization?redirect_uri=https%3A%2F%2Fevil.test%2Fcallback'),
    /loopback/,
  )
  assert.throws(
    () => parseAuthorizationTarget('http://example.test/authorization?redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fcallback'),
    /HTTPS/,
  )
})

test('native and TypeScript launchers cannot reintroduce the subtractive loopback rule', () => {
  const root = process.cwd()
  const engineSource = readFileSync(path.join(root, 'server', 'engine.ts'), 'utf8')
  const nativeSource = readFileSync(path.join(root, 'native', 'hook_dll', 'hook_dll.c'), 'utf8')
  const forbiddenSwitch = '--proxy-bypass-list=' + '<-loopback>'
  // Comments may explain the historical bug; executable string literals must not contain it.
  assert.equal(engineSource.includes(`args.push('${forbiddenSwitch}')`), false)
  assert.equal(nativeSource.includes(`L\" ${forbiddenSwitch}\"`), false)
  assert.match(nativeSource, /\*p\+\+ = L'"';\s*\*p = L'\\0';/)
})
