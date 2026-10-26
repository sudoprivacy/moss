/** Provision the operator-owned Moss issuer used by a Kubernetes controller. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectNodeAdmin } from './nodeAdmin.js'

/** Publish complete private credential files, then grant the existing session-minter role. */
export async function provisionMossIssuer(directory: string, endpoint: string) {
  const identity = join(directory, 'moss-client')
  const client = connectNodeAdmin(join(directory, 'tls'), endpoint)
  try {
    await client.waitForIssuer()
    if (!existsSync(identity)) {
      const minted = await client.rpc('MintAgent', {
        subject_id: 'atlas-moss', display_name: 'Atlas Moss controller', allow_existing: false,
      })
      assert(minted.success, 'MintAgent refused: ' + minted.error)
      const files = { 'agent.pem': minted.agent_cert_pem, 'agent-key.pem': minted.agent_key_pem, 'ca.pem': minted.ca_pem }
      assert(Object.values(files).every(Buffer.isBuffer), 'MintAgent must return complete credentials')
      const staged = mkdtempSync(join(directory, '.moss-client-'))
      for (const [name, value] of Object.entries(files))
        writeFileSync(join(staged, name), value!, { mode: 0o600, flag: 'wx' })
      renameSync(staged, identity)
    }
    assert(['agent.pem', 'agent-key.pem', 'ca.pem'].every(name => existsSync(join(identity, name))),
      'Existing Moss issuer credentials are incomplete')
    const allowed = await client.rpc('AllowSessionMinter', { agent_id: 'atlas-moss' })
    assert(allowed.success, 'AllowSessionMinter refused: ' + allowed.error)
    return { endpoint, tls: { ca: join(identity, 'ca.pem'), cert: join(identity, 'agent.pem'),
      key: join(identity, 'agent-key.pem'), serverName: 'nexus-node' } }
  } finally {
    client.close()
  }
}
