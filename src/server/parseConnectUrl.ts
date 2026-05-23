import path from 'path'

export function buildConnectUrl(options: {
  host: string
  port: number
  unix?: string
}): string {
  if (options.unix) {
    return `cc+unix://${encodeURIComponent(path.resolve(options.unix))}`
  }

  return `cc://${options.host}:${options.port}`
}

export function parseConnectUrl(
  ccUrl: string,
): {
  serverUrl: string
  authMode: 'local'
  authToken?: string
} {
  if (ccUrl.startsWith('cc+unix://')) {
    const url = new URL(ccUrl)
    const socketPath = decodeURIComponent(url.hostname + url.pathname)
    if (!socketPath) {
      throw new Error(`Invalid direct-connect URL: ${ccUrl}`)
    }
    throw new Error(
      `Unix domain socket direct-connect is not supported by this build (${socketPath}). Use the HTTP listener instead.`,
    )
  }

  if (!ccUrl.startsWith('cc://')) {
    throw new Error(`Invalid direct-connect URL: ${ccUrl}`)
  }

  const url = new URL(ccUrl)
  if (url.searchParams.get('token')) {
    throw new Error(
      `Static token URLs are no longer supported: ${ccUrl}. Use bearer auth instead.`,
    )
  }
  const authMode = url.searchParams.get('auth_mode')
  if (authMode && authMode !== 'auth-center' && authMode !== 'local') {
    throw new Error(`Unsupported direct-connect auth mode in URL: ${authMode}`)
  }
  if (!url.hostname || !url.port) {
    throw new Error(`Invalid direct-connect URL: ${ccUrl}`)
  }
  const serverUrl = `http://${url.hostname}:${url.port}`

  return {
    serverUrl,
    authMode: 'local',
  }
}
