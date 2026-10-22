// Presentation only. The server validates the fixed-IP /v1 boundary and current policy before any request.
export function normalizeEndpoint(value: string): string {
  try { return new URL(value.trim()).href.replace(/\/+$/, '') } catch { return value.trim() }
}
export function isEndpointAllowed(endpoint: string, endpoints: string[]): boolean {
  return endpoints.some(value => normalizeEndpoint(value) === normalizeEndpoint(endpoint))
}
