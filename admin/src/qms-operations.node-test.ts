import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QMS_OPERATION_TABS, crashIssueActions } from './qms-operations.js'

test('QMS 管理端覆盖旧后台全部八类运维视图', () => {
  assert.deepEqual(QMS_OPERATION_TABS, [
    'overview', 'conversations', 'installs', 'performance', 'users', 'crashes', 'alerts', 'system',
  ])
  assert.deepEqual(crashIssueActions('unresolved'), ['detail', 'resolve', 'ignore'])
  assert.deepEqual(crashIssueActions('resolved'), ['detail'])
  assert.deepEqual(crashIssueActions('ignored'), ['detail'])
})
