import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachProcessToJob, releaseInstanceJob, terminateInstanceJob } from '../server/job-object.js'

test('Job Object 组件在非 Windows 或无效输入下安全失败', () => {
  assert.equal(attachProcessToJob('', 0), false)
  assert.equal(terminateInstanceJob('missing-instance'), false)
  releaseInstanceJob('missing-instance')
})
