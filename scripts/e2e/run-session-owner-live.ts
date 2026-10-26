/** Bootstrap an isolated real issuer and run the existing session ownership journey. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startIsolatedNexus } from './fixtures/isolated-nexus.js'

const [binaryInput, probeInput] = process.argv.slice(2)
assert(binaryInput && probeInput, 'Installed daemon and bundled ownership probe are required')
const binary = resolve(binaryInput)
const probe = resolve(probeInput)
const artifacts = process.env.MOSS_NEXUS_LIVE_ARTIFACTS ?? tmpdir()
mkdirSync(artifacts, { recursive: true })
const results = mkdtempSync(join(artifacts, 'moss-session-owner-'))
const issuer = await startIsolatedNexus(binary)
let isPassed = false
try {
  const child = spawn(process.execPath, [probe, join(issuer.data, 'tls'), issuer.endpoint], {
    env: { ...issuer.environment, TMPDIR: issuer.privateRoot, TMP: issuer.privateRoot, TEMP: issuer.privateRoot },
    stdio: 'inherit', windowsHide: true, timeout: 60_000,
  })
  const [exitCode, signal] = await once(child, 'exit')
  assert.equal(signal, null, 'the ownership journey must finish before its deadline')
  assert.equal(exitCode, 0, 'the real mTLS ownership journey must pass')
  isPassed = true
} finally {
  await issuer.stop()
  writeFileSync(join(results, 'acceptance.json'), JSON.stringify({
    success: isPassed, daemonSha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    checks: ['real isolated issuer', 'Node-authorized session minter', 'user-bound mTLS credential',
      'certificate-derived session owner', 'foreign body owner refused', 'foreign certificate refused',
      'bare issuer refused', 'owned child cleanup'],
  }, null, 2))
  console.log(`Ownership acceptance: ${results}`)
}
