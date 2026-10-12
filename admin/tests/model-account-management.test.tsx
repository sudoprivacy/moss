import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelProvisioningAction } from '../src/components/model-account-management'
import type { ModelToken } from '../lib/api/model-billing'

const renderAction = (token?: ModelToken) => renderToStaticMarkup(
  <ModelProvisioningAction token={token} busy={false} onProvision={() => {}} onReconcile={() => {}} />,
)

test('pending or absent member binding offers normal provisioning', () => {
  const pending = renderAction({ user_id: 'member-a', purpose: 'member', provisioning_status: 'pending' })
  assert.match(pending, /开通成员 Key/)
  assert.doesNotMatch(pending, /核对远端 Key/)
})

test('needs_review member binding only offers remote reconciliation', () => {
  const review = renderAction({
    user_id: 'member-a', purpose: 'member', provisioning_status: 'needs_review', review_outcome: 'missing', checked_at: Date.now(),
  })
  assert.match(review, /核对远端 Key/)
  assert.match(review, /不会创建新 Key|避免重复创建/)
  assert.doesNotMatch(review, />开通成员 Key</)
})

test('ambiguous and unavailable outcomes direct the operator to manual review', () => {
  for (const outcome of ['ambiguous', 'key_unavailable', 'capability_unavailable'] as const) {
    const html = renderAction({ user_id: 'member-a', purpose: 'member', provisioning_status: 'needs_review', review_outcome: outcome })
    assert.match(html, /超级管理员/)
    assert.match(html, /核对远端 Key/)
  }
})
