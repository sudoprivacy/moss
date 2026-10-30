import { readFile } from 'node:fs/promises'
import { createCompilerContextWorker } from './compilerContextWorker.js'
import { compilerWorkerConfiguration } from './compilerWorkerConfig.js'

async function main() {
  const path = process.argv[2]
  if (!path) throw new Error('Supply the deployment-owned compiler worker configuration path')
  const config = compilerWorkerConfiguration(JSON.parse(await readFile(path, 'utf8')), process.env)
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
