/** Native and standalone engines resolve models through the same proxy connection. */
export function buildScodeProxyConfig(baseUrl: string, apiKey: string): Record<string, string> {
  return { 'sudocode.json': JSON.stringify({ auth_modes: { proxy: { 'moss-proxy': { baseUrl, apiKey } } } }) }
}

/** Install the native model driver; the engine supplies its user's request credential. */
export function buildCohostProxyConfig(baseUrl: string, apiKey: string): Record<string, string> {
  return {
    ...buildScodeProxyConfig(baseUrl, apiKey),
    'backend-config.json': JSON.stringify({ mounts: [{ path: '/model', backend_type: 'anthropic',
      backend_name: 'moss-model-proxy', backend_params: {
        base_url: baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''), blob_root: '/data/model-cache',
      } }] }),
  }
}
