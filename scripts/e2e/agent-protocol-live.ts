import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CustomHttpAdapter } from '../../src/server/agentFederation/customHttpAdapter.js'
import { StandardHttpAdapter, isStandardProtocol } from '../../src/server/agentFederation/standardHttpAdapter.js'
import { customManifestDigest, parseCustomManifest } from '../../src/server/agentFederation/manifest.js'

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() }); child.kill('SIGTERM')
  })
}
const directory = await mkdtemp(join(tmpdir(), 'agent-protocol-process-')), results: unknown[] = []
try {
  for (const protocol of ['http', 'openai', 'mcp', 'a2a']) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/agent-protocol-reference.ts', protocol, join(directory, protocol)], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = '', stderr = ''
        const timer = setTimeout(() => reject(new Error(`Reference startup timed out: ${protocol}`)), 15000)
        child.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-2000) })
        child.stdout!.on('data', data => { stdout += String(data); if (stdout.includes('\n')) { clearTimeout(timer); resolve() } })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Reference exited ${code}: ${stderr}`)) })
      })
      const connection = JSON.parse(await readFile(join(directory, protocol, `${protocol}.connection.json`), 'utf8'))
      const manifest = parseCustomManifest(await readFile(join(directory, protocol, `${protocol}.manifest.json`), 'utf8'))
      const reviewed = { manifest, digest: customManifestDigest(manifest) }
      const adapter = isStandardProtocol(manifest) ? new StandardHttpAdapter(reviewed) : new CustomHttpAdapter(reviewed)
      let admitted = 0
      const result = await adapter.invoke({ task_id: randomUUID(), attempt_id: randomUUID(), session_id: randomUUID(), binding_id: 'process-reference',
        external_agent_id: manifest.external_agent_id, source_digest: reviewed.digest, endpoint: connection.endpoint, key: connection.api_key,
        org_id: 'process-lab', policy: { orgIds: ['process-lab'], endpoints: [connection.endpoint], timeoutMs: 5000 },
        query: '6 * 7', end_user: 'synthetic-user', provider_session_id: null, signal: AbortSignal.timeout(5000), authorize_dispatch: async () => { admitted++ },
      }, async () => {})
      assert.equal(result.status, 'succeeded'); assert.equal(result.text, '42'); assert.equal(admitted, 1)
      results.push({ protocol, status: result.status, answer: result.text, binding: result.binding, evidence: 'standalone-local-reference', actualModel: false })
    } finally { await stop(child) }
  }
  const report = JSON.stringify({ passed: results.length, results }, null, 2) + '\n'
  if (process.argv[2]) await writeFile(process.argv[2], report)
  console.log(report)
} finally { await rm(directory, { recursive: true, force: true }) }
