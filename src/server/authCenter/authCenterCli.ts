function printHelp(): void {
  process.stdout.write(
    [
      'moss-auth-center 已废弃。',
      '',
      '请改用统一后的 moss-server / direct-connect-server 入口：',
      '  node moss-server.mjs',
      '  或 node direct-connect-server.mjs',
      '',
      'Admin UI 由同一个 server 挂载在 /admin，认证接口也统一到同一个 base URL。',
      '',
    ].join('\n'),
  )
}

async function main(): Promise<void> {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    printHelp()
    process.exit(0)
  }

  process.stderr.write(
    [
      'moss-auth-center 已废弃，请改用统一后的 moss-server。',
      '新的入口会同时提供 auth、admin、sessions 和 /admin SPA。',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
