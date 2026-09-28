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

/** Schemes a minted (login-type) token can be injected with. */
export const MINTED_TOKEN_SCHEMES = ['bearer', 'header', 'query'] as const

/**
 * Inject a minted access_token per the login-type config item's placement:
 *   - 'header': `<tokenParam>: <token>` (e.g. `Token: xxx`)
 *   - 'query':  `?<tokenParam>=<token>`
 *   - otherwise (null/''/'bearer'): `Authorization: <prefix || Bearer> <token>`
 * header/query without a tokenParam fall back to Bearer, so a half-configured
 * item keeps the historical behavior instead of dropping the token.
 */
export function injectMintedToken(
  placement: { scheme?: string | null; prefix?: string | null; tokenParam?: string | null },
  token: string,
): InjectAuthResult {
  const name = placement.tokenParam?.trim()
  if (name && (placement.scheme === 'header' || placement.scheme === 'query')) {
    return injectAuth({ scheme: placement.scheme, secret: token, headerName: name })
  }
  return injectAuth({ scheme: 'bearer', secret: token, prefix: placement.prefix || undefined })
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
