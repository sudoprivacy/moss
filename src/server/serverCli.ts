import { readServerConfig } from './config.js'
import { startStandaloneDirectConnectServer } from './startStandaloneServer.js'

async function main(): Promise<void> {
  const { configPath, config } = await readServerConfig()

  // server.json can contain bootstrap credentials and integration secrets.
  // Log only its location; dumping the parsed object leaks those values into
  // journald in host deployments.
  process.stderr.write(`\n[ServerCli] Configuration: ${configPath}\n`)

  const running = await startStandaloneDirectConnectServer(config)

  process.stderr.write(`\nConfig: ${configPath}\n`)
  if (running.bootstrapAdminUsername) {
    process.stderr.write(`Bootstrap admin username: ${running.bootstrapAdminUsername}\n`)
  }
  if (running.bootstrapAdminEmail) {
    process.stderr.write(`Bootstrap admin email: ${running.bootstrapAdminEmail}\n`)
  }

  const shutdown = async () => {
    await running.stop()
    process.exit(0)
  }

  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
