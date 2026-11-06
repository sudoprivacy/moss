import assert from 'node:assert/strict'
import { posix } from 'node:path'

/** Accept native directory entries without duplicating the selected model mount. */
export function modelPromptPath(mount: string, entry: string): string {
  assert(mount.startsWith('/') && !mount.endsWith('/') && posix.normalize(mount) === mount, 'Use a canonical model mount')
  const prefix = `${mount}/`
  const name = entry.startsWith(prefix) ? entry.slice(prefix.length) : entry
  assert(name.endsWith('.prompt') && !name.includes('/') && !name.includes('\\'),
    'Model evidence must be a direct prompt child of the selected mount')
  return prefix + name
}
