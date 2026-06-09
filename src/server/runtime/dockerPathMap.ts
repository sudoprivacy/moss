/**
 * `MOSS_HOST_PATH_MAP` translates a container-internal path back to the
 * host-side path that the Docker daemon needs for `-v` mounts when
 * moss-server itself runs inside a container.
 *
 * Format: JSON object of `{ "<host-path>": "<container-path>" }` entries.
 * Example:
 *   MOSS_HOST_PATH_MAP='{"/data/moss-server/moss/data/runtime":"/app/data/runtime"}'
 *
 * Used by both DockerBackend (session-mode `docker run -v ...`) and
 * UserContainerRegistry (user-mode `docker run -d -v ...`). Centralized
 * here so they cannot diverge.
 */

let cachedRaw: string | undefined
let cachedMap: Record<string, string> | null = null

function readMap(): Record<string, string> | null {
  const raw = process.env.MOSS_HOST_PATH_MAP
  if (raw === cachedRaw) return cachedMap
  cachedRaw = raw
  if (!raw) {
    cachedMap = null
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    if (parsed && typeof parsed === 'object') {
      cachedMap = parsed
      return parsed
    }
  } catch {
    process.stderr.write(`[dockerPathMap] Invalid MOSS_HOST_PATH_MAP: ${raw}\n`)
  }
  cachedMap = null
  return null
}

/**
 * Longest-prefix-match the container path against the configured entries.
 * Returns the original path unchanged if no map entry matches — that's the
 * correct behavior when moss-server runs natively on the host.
 */
export function toHostPath(containerPath: string): string {
  const map = readMap()
  if (!map) return containerPath

  let bestContainerPrefix = ''
  let bestHostPrefix = ''
  for (const [hostPrefix, containerPrefix] of Object.entries(map)) {
    if (
      containerPath.startsWith(containerPrefix) &&
      containerPrefix.length > bestContainerPrefix.length
    ) {
      bestContainerPrefix = containerPrefix
      bestHostPrefix = hostPrefix
    }
  }

  if (bestContainerPrefix) {
    return containerPath.replace(bestContainerPrefix, bestHostPrefix)
  }
  return containerPath
}

/**
 * Test-only: clear the cached parse so a new MOSS_HOST_PATH_MAP env value
 * gets re-read on the next call. Production code never mutates env mid-run.
 */
export function _resetForTests(): void {
  cachedRaw = undefined
  cachedMap = null
}
