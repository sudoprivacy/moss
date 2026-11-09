import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { assertLocalEgressDeployment, hostRuntimeSchema, readHostEgressSnapshot } from './hostEgressRuntime.js'

void test('local qualification is bound to the actual cohost deployment and policy organization', () => {
  const deployment = { runtimeDefaults: { type: 'cohost' }, egressGate: { localPolicyFile: '/policy/current.json', localOrganizationId: 'box-org' } }
  assertLocalEgressDeployment(deployment, 'box-org')
  assert.throws(() => assertLocalEgressDeployment(deployment, 'another-org'), /local policy organization/)
  assert.throws(() => assertLocalEgressDeployment({ runtimeDefaults: { type: 'k8s' } }, 'box-org'), /cohost default/)
  assert.throws(() => assertLocalEgressDeployment({ runtimeDefaults: { type: 'cohost' } }, 'box-org'), /local policy organization/)
  assert.throws(() => assertLocalEgressDeployment({ ...deployment, egressGate: { ...deployment.egressGate, localPolicyFile: 'relative' } }, 'box-org'), /controller-owned/)
})

void test('a changed placement pin is refused before loading or invoking the library', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-egress-pin-'))
  try {
    const pin = join(root, 'pin.json')
    writeFileSync(pin, '{}')
    const profile = hostRuntimeSchema.parse({ pinFile: pin, pinSha256: '0'.repeat(64),
      placementLibrary: join(root, 'nonexistent.py'), placementLibrarySha256: '0'.repeat(64) })
    assert.throws(() => readHostEgressSnapshot(profile, { policyFile: '/policy/current.json', endpoint: 'https://127.0.0.1:22141' }), /Local placement pin changed/)
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()))
    assert(basename(root).startsWith('host-egress-pin-'))
    rmSync(root, { recursive: true, force: true })
  }
})

void test('a changed placement library is never executed', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'host-egress-pin-'))
  try {
    const pin = join(root, 'pin.json'), library = join(root, 'placement.py'), marker = join(root, 'executed')
    const policy = join(root, 'policy/current.json')
    const raw = JSON.stringify({ policyLive: policy, container: { mounts: [{ source: dirname(policy), target: '/policy', readOnly: true }] } })
    writeFileSync(pin, raw)
    writeFileSync(library, `from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('unexpected execution')`)
    assert.throws(() => readHostEgressSnapshot({ pinFile: pin, pinSha256: createHash('sha256').update(raw).digest('hex'),
      placementLibrary: library, placementLibrarySha256: '0'.repeat(64) }, { policyFile: policy, endpoint: 'https://127.0.0.1:22141' }),
    /installed shared local placement verifier refused/)
    assert.equal(existsSync(marker), false)
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()))
    assert(basename(root).startsWith('host-egress-pin-'))
    rmSync(root, { recursive: true, force: true })
  }
})
