import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { instanceLayout, isWithinRoot, resolveInstanceRoot, resolveProfileRoot } from '../server/instance-layout.js'

test('实例目录布局只包含约定的私有和共享边界', () => {
  const root = path.resolve('engine', 'instances', 'profile-1', '2')
  const layout = instanceLayout(root)
  assert.equal(layout.config, path.join(root, 'config'))
  assert.equal(layout['browser-profile-v2'], path.join(root, 'browser-profile-v2'))
  assert.equal(layout.logs, path.join(root, 'logs'))
  assert.equal(layout.shared, path.join(root, 'shared'))
})

test('实例路径拒绝穿越、绝对 profileId 和非法序号', () => {
  const root = path.resolve('engine', 'instances')
  assert.ok(resolveProfileRoot(root, 'profile-1'))
  assert.equal(resolveProfileRoot(root, '..\\outside'), null)
  assert.equal(resolveProfileRoot(root, path.resolve('outside')), null)
  assert.ok(resolveInstanceRoot(root, 'profile-1', 1))
  assert.equal(resolveInstanceRoot(root, 'profile-1', 0), null)
  assert.equal(resolveInstanceRoot(root, 'profile-1', 1000001), null)
})

test('宿主目录保护不允许把 instances 根目录本身当作实例', () => {
  const root = path.resolve('engine', 'instances')
  assert.equal(isWithinRoot(root, root), false)
  assert.equal(isWithinRoot(root, path.join(root, 'profile-1', '1')), true)
  assert.equal(isWithinRoot(root, path.resolve(root, '..', 'outside')), false)
})
