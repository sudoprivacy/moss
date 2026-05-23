import { buildConnectUrl } from './parseConnectUrl.js'

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') {
    return '127.0.0.1'
  }
  return host
}

export function printBanner(
  config: {
    host: string
    port: number
    unix?: string
  },
  actualPort: number,
): void {
  const connectUrl = buildConnectUrl({
    host: displayHost(config.host),
    port: actualPort,
    unix: config.unix,
  })
  const adminUrl = config.unix
    ? null
    : `http://${displayHost(config.host)}:${actualPort}/admin`

  process.stderr.write(
    [
      '',
      'Moss server started.',
      config.unix
        ? `Socket: ${config.unix}`
        : `HTTP: http://${displayHost(config.host)}:${actualPort}`,
      adminUrl ? `Admin: ${adminUrl}` : null,
      `Connect: ${connectUrl}`,
      '',
    ].filter(Boolean).join('\n'),
  )
}
