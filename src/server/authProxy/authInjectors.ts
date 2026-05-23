export interface InjectAuthParams {
  scheme: string
  secret: string
  headerName?: string
  prefix?: string
}

export interface InjectAuthResult {
  headers: Record<string, string>
  url?: string
}

export function injectAuth(params: InjectAuthParams): InjectAuthResult {
  const { scheme, secret, headerName = 'X-API-Key', prefix } = params

  switch (scheme) {
    case 'bearer':
      return { headers: { Authorization: `${prefix || 'Bearer'} ${secret}` } }
    case 'basic':
      return { headers: { Authorization: `Basic ${Buffer.from(secret).toString('base64')}` } }
    case 'header':
      return { headers: { [headerName]: secret } }
    case 'query':
      return { headers: {}, url: `${headerName}=${encodeURIComponent(secret)}` }
    default:
      return { headers: {} }
  }
}

export function injectMultiAuth(
  scheme: string,
  entries: Array<{ configKey: string; value: string }>,
): InjectAuthResult {
  const headers: Record<string, string> = {}
  const queryParts: string[] = []

  for (const entry of entries) {
    switch (scheme) {
      case 'header':
        headers[entry.configKey] = entry.value
        break
      case 'query':
        queryParts.push(`${entry.configKey}=${encodeURIComponent(entry.value)}`)
        break
    }
  }

  return {
    headers,
    url: queryParts.length > 0 ? queryParts.join('&') : undefined,
  }
}
