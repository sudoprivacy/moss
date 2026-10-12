/** Share the SudoWork conversation renderer without putting credentials in a URL. */
export function agentWorkspaceUrl(sessionId: string, baseUrl = process.env.MOSS_WORKSPACE_URL): string | null {
  if (!baseUrl) return null
  try {
    const url = new URL(baseUrl)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
    url.hash = `/conversation/${encodeURIComponent(sessionId)}`
    return url.toString()
  } catch { return null }
}
