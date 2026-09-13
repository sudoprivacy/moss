import {
  applyEdits,
  modify,
  parse as parseJsonc,
} from 'jsonc-parser/lib/esm/main.js'
import { stripBOM } from './jsonRead.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { jsonStringify } from './slowOperations.js'

type CachedParse = { ok: true; value: unknown } | { ok: false }

// Memoized inner parse. Uses a discriminated-union wrapper because:
// 1. memoizeWithLRU requires NonNullable<unknown>, but JSON.parse can return
//    null (e.g. JSON.parse("null")).
// 2. Invalid JSON must also be cached — otherwise repeated calls with the same
//    bad string re-parse and re-log every time (behavioral regression vs the
//    old lodash memoize which wrapped the entire try/catch).
// Bounded to 50 entries to prevent unbounded memory growth — previously this
// used lodash memoize which cached every unique JSON string forever (settings,
// .mcp.json, notebooks, tool results), causing a significant memory leak.
// Note: shouldLogError is intentionally excluded from the cache key (matching
// lodash memoize default resolver = first arg only).
// Skip caching above this size — the LRU stores the full string as the key,
// so a 200KB config file would pin ~10MB in #keyList across 50 slots. Large
// inputs like ~/.claude.json also change between reads (numStartups bumps on
// every CC startup), so the cache never hits anyway.
const PARSE_CACHE_MAX_KEY_BYTES = 8 * 1024

function parseJSONUncached(json: string, shouldLogError: boolean): CachedParse {
  try {
    return { ok: true, value: JSON.parse(stripBOM(json)) }
  } catch (e) {
    if (shouldLogError) {
      logError(e)
    }
    return { ok: false }
  }
}

const parseJSONCached = memoizeWithLRU(parseJSONUncached, json => json, 50)

// Important: memoized for performance (LRU-bounded to 50 entries, small inputs only).
export const safeParseJSON = Object.assign(
  function safeParseJSON(
    json: string | null | undefined,
    shouldLogError: boolean = true,
  ): unknown {
    if (!json) return null
    const result =
      json.length > PARSE_CACHE_MAX_KEY_BYTES
        ? parseJSONUncached(json, shouldLogError)
        : parseJSONCached(json, shouldLogError)
    return result.ok ? result.value : null
  },
  { cache: parseJSONCached.cache },
)

/**
 * Safely parse JSON with comments (jsonc).
 * This is useful for VS Code configuration files like keybindings.json
 * which support comments and other jsonc features.
 */
export function safeParseJSONC(json: string | null | undefined): unknown {
  if (!json) {
    return null
  }
  try {
    // Strip BOM before parsing - PowerShell 5.x adds BOM to UTF-8 files
    return parseJsonc(stripBOM(json))
  } catch (e) {
    logError(e)
    return null
  }
}

/**
 * Modify a jsonc string by adding a new item to an array, preserving comments and formatting.
 * @param content The jsonc string to modify
 * @param newItem The new item to add to the array
 * @returns The modified jsonc string
 */

// parseJSONL / readJSONLFile moved to ./jsonl.ts (server modules need JSONL
// reads without json.ts's CLI-only import graph). Re-exported here so existing
// importers (sessionStorage.ts, sessionUsage.ts, analytics exporter) stay
// unchanged.
export { parseJSONL, readJSONLFile } from './jsonl.js'

export function addItemToJSONCArray(content: string, newItem: unknown): string {
  try {
    // If the content is empty or whitespace, create a new JSON file
    if (!content || content.trim() === '') {
      return jsonStringify([newItem], null, 4)
    }

    // Strip BOM before parsing - PowerShell 5.x adds BOM to UTF-8 files
    const cleanContent = stripBOM(content)

    // Parse the content to check if it's valid JSON
    const parsedContent = parseJsonc(cleanContent)

    // If the parsed content is a valid array, modify it
    if (Array.isArray(parsedContent)) {
      // Get the length of the array
      const arrayLength = parsedContent.length

      // Determine if we are dealing with an empty array
      const isEmpty = arrayLength === 0

      // If it's an empty array we want to add at index 0, otherwise append to the end
      const insertPath = isEmpty ? [0] : [arrayLength]

      // Generate edits - we're using isArrayInsertion to add a new item without overwriting existing ones
      const edits = modify(cleanContent, insertPath, newItem, {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
        isArrayInsertion: true,
      })

      // If edits could not be generated, fall back to manual JSON string manipulation
      if (!edits || edits.length === 0) {
        const copy = [...parsedContent, newItem]
        return jsonStringify(copy, null, 4)
      }

      // Apply the edits to preserve comments (use cleanContent without BOM)
      return applyEdits(cleanContent, edits)
    }
    // If it's not an array at all, create a new array with the item
    else {
      // If the content exists but is not an array, we'll replace it completely
      return jsonStringify([newItem], null, 4)
    }
  } catch (e) {
    // If parsing fails for any reason, log the error and fallback to creating a new JSON array
    logError(e)
    return jsonStringify([newItem], null, 4)
  }
}
