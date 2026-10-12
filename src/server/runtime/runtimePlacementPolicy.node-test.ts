import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ResourceAccessError } from '../catalog/resourceError.js'
import { assertRuntimePlacement } from './runtimePlacementPolicy.js'

for (const type of ['host', 'docker']) {
  void test(`an owner-Pod cloud deployment refuses ${type} execution on the Moss host`, () => {
    assert.throws(() => assertRuntimePlacement(type, true), error => error instanceof ResourceAccessError && error.statusCode === 403)
  })
  void test(`a private deployment retains its configured ${type} execution`, () => {
    assert.doesNotThrow(() => assertRuntimePlacement(type, false))
  })
}
void test('both native owner boxes and legacy gVisor sessions remain valid compute placements', () => {
  assert.doesNotThrow(() => assertRuntimePlacement('cohost', true, true))
  assert.doesNotThrow(() => assertRuntimePlacement('k8s', true, true))
})
void test('a native cloud default refuses new legacy placements while retaining existing gVisor sessions', () => {
  assert.throws(() => assertRuntimePlacement('k8s', true, true, true), error => error instanceof ResourceAccessError && error.statusCode === 403)
  assert.doesNotThrow(() => assertRuntimePlacement('cohost', true, true, true))
  assert.doesNotThrow(() => assertRuntimePlacement('k8s', true, true, false))
})
void test('metered native sessions cannot spend a deployment credential through the legacy daemon', () => {
  assert.throws(() => assertRuntimePlacement('cohost', false, true), error => error instanceof ResourceAccessError && error.statusCode === 503)
  assert.doesNotThrow(() => assertRuntimePlacement('cohost', false, false))
})
