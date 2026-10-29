import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { createCompilerContextWorker } from './compilerContextWorker.js'

const reference = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const configuration = z.object({
  binding: z.object({ authorityRef: reference, modelRef: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    sourceRefs: z.array(reference).max(1000) }).strict(),
  runtime: z.object({ python: z.string().min(1), compilerRoot: z.string().min(1), modelDirectory: z.string().min(1) }).strict(),
  actor: z.string().trim().min(1).max(128),
  host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(0).max(65535),
}).strict()

async function main() {
  const path = process.argv[2]
  if (!path) throw new Error('Supply the deployment-owned compiler worker configuration path')
  const config = configuration.parse(JSON.parse(await readFile(path, 'utf8')))
  const server = createCompilerContextWorker({ ...config, token: process.env.SUDOGRAPH_WORKER_TOKEN ?? '' })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
  })
  const shutdown = () => { server.close(); server.closeIdleConnections() }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Worker did not bind a TCP port')
  process.stdout.write(JSON.stringify({ format: 'sudograph-worker-ready/v1', port: address.port }) + '\n')
}

main().catch(() => {
  // Configuration and compiler errors can contain private paths and credentials.
  process.stderr.write('Sudograph compiler worker could not start; verify deployment configuration and token\n')
  process.exitCode = 1
})
