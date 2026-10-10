const LEGACY_TEMPLATE_PATH = /^\/api\/v1\/agents\/(?:visible|installed|install|create|meta|uninstall|visibility|sync-from-hub|sync|sync-status|custom|tenant)(?:\/|$)/
const LEGACY_TEMPLATE_RUNTIME_PATH = /^\/api\/v1\/agents\/[^/]+\/(?:enhancement|chat|conversations|messages|parameters|meta|files|audio-to-text|text-to-audio)(?:\/|$)/
const LEGACY_TEMPLATE_ADMIN_PATH = /^\/api\/v1\/admin\/agents\/tenant(?:\/|$)/

/** Resolve known template aliases without claiming the personal Agent namespace. */
export function canonicalAgentTemplatePath(pathname: string): string {
  if (/^\/api\/v1\/agents\/private-archives(?:\/|$)/.test(pathname)) return pathname
  if (LEGACY_TEMPLATE_PATH.test(pathname) || LEGACY_TEMPLATE_RUNTIME_PATH.test(pathname) || LEGACY_TEMPLATE_ADMIN_PATH.test(pathname)) {
    return pathname.replace(/^\/api\/v1\/(admin\/)?agents\//, '/api/v1/$1agent-templates/')
  }
  return pathname
}
