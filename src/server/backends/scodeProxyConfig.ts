function proxyConfiguration(baseUrl: string, apiKey: string) {
  return { auth_modes: { proxy: { 'moss-proxy': { baseUrl, apiKey } } } }
}

/** Native and standalone engines use the same proxy account configuration. */
export function buildScodeProxyConfig(baseUrl: string, apiKey: string): Record<string, string> {
  return { 'sudocode.json': JSON.stringify(proxyConfiguration(baseUrl, apiKey)) }
}

/** The native engine uses its mount; the backend owns the upstream credential. */
export function buildCohostProxyConfig(baseUrl: string, apiKey: string, model: string): Record<string, string> {
  return {
    'sudocode.json': JSON.stringify({ ...proxyConfiguration('nexus:///model', ''),
      models: { [model]: { providers: { proxy: { model } } } } }),
    'backend-config.json': JSON.stringify({ mounts: [{ path: '/model', backend_type: 'anthropic',
      backend_name: 'moss-model-proxy', backend_params: {
        base_url: baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
        openai_base_url: baseUrl.replace(/\/+$/, ''), api_key: apiKey, blob_root: '/data/model-cache',
      } }] }),
  }
}
