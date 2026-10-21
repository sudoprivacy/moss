import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { startProtocolReference, type ReferenceProtocol } from '../src/server/testing/standardProtocolReference.js'
import { discoverStandardManifest } from '../src/server/agentFederation/standardHttpAdapter.js'
import type { StandardHttpProtocol } from '../contracts/agent-federation/v1alpha1/contract.js'

const protocol = process.argv[2] as ReferenceProtocol, directory = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'agent-protocol-reference-'))
if (!['http', 'openai', 'mcp', 'a2a'].includes(protocol)) throw new Error('Usage: node --import tsx scripts/agent-protocol-reference.ts <http|openai|mcp|a2a> [private-output-directory] [port]')
const port = Number(process.argv[4] ?? 0)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
const key = randomBytes(32).toString('hex')
const service = await startProtocolReference(protocol, key, port)
const stop = async () => { await service.close(); process.exit(0) }
process.once('SIGTERM', () => { void stop() }); process.once('SIGINT', () => { void stop() })
try {
  const protocols: Record<string, StandardHttpProtocol> = { openai: 'openai-chat-completions/v1', mcp: 'mcp/2025-06-18', a2a: 'a2a/0.3.0' }
  const manifest = protocol === 'http' ? service.legacyManifest() : await discoverStandardManifest({ endpoint: service.endpoint, key,
    protocol: protocols[protocol], target: service.target, agentId: service.target, name: `Local ${protocol} reference` }, AbortSignal.timeout(10000))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(resolve(directory, `${protocol}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await writeFile(resolve(directory, `${protocol}.connection.json`), JSON.stringify({ endpoint: service.endpoint, api_key: key, provider_kind: 'custom_http', app_id: service.target, workspace_id: 'local-reference' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ protocol, endpoint: service.endpoint, files: directory, evidence: 'local-reference-only', model: 'deterministic-no-external-model' }))
} catch (error) { await service.close(); throw error }
