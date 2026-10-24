import { buildCohostModelConfiguration } from '@sudo/user-runtime'

function proxyConfiguration(baseUrl: string, apiKey: string) {
  return { auth_modes: { proxy: { 'moss-proxy': { baseUrl, apiKey } } } }
}

/** Native and standalone engines use the same proxy account configuration. */
export function buildScodeProxyConfig(baseUrl: string, apiKey: string): Record<string, string> {
  return { 'sudocode.json': JSON.stringify(proxyConfiguration(baseUrl, apiKey)) }
}

/** The native engine uses its mount; the backend owns the upstream credential. */
export function buildCohostProxyConfig(baseUrl: string, apiKey: string, model: string): Record<string, string> {
  return buildCohostModelConfiguration([{ id: 'moss-proxy', backendName: 'moss-model-proxy', mountPath: '/model', baseUrl, apiKey, models: [model] }])
}
