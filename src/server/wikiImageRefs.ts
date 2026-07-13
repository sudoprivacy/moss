// Rewrite relative markdown image refs in wiki content to public, tokenized
// resource URLs. The agent reads wiki markdown (`![](images/fig-001.png)`) and
// relays it to the client verbatim; unless the relative ref is rewritten to a
// browser-loadable URL, the client can't display the image. We re-express each
// safe relative ref as an opaque, unguessable token URL served by the public
// `/api/v1/resources/:token/*` route.

import path from 'node:path'
import { encodeResourceToken } from './wikiResourceToken.js'

export const RESOURCE_PREFIX = '/api/v1/resources'

// Matches markdown image syntax: `![alt](url "optional title")`. Captures the
// alt text prefix, the url, and any trailing title/whitespace so we can rebuild
// the ref with only the url swapped. The url group stops at whitespace or `)`.
const MD_IMAGE_RE = /(!\[[^\]]*\]\()(\s*<?)([^)\s>]+)(>?\s*(?:"[^"]*"|'[^']*')?\s*\))/g

function isAbsoluteRef(url: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) || // scheme: http:, https:, data:, mailto:…
    url.startsWith('//') || // protocol-relative
    url.startsWith('#') // in-page anchor
  )
}

export function isMarkdownPath(p: string): boolean {
  return p.toLowerCase().endsWith('.md')
}

/**
 * Rewrite relative markdown image refs in `md` to public tokenized resource
 * URLs. `srcFile` is the wiki-relative path of the markdown file the text came
 * from; relative image paths are resolved against its directory, validated to
 * stay inside the wiki, then re-expressed as a wiki-root-relative path encoded
 * into an opaque token. Already-absolute refs and refs that escape the wiki are
 * left untouched.
 *
 * `publicBaseUrl` is prepended to the URL (`''` → root-relative). `secret` keys
 * the token's integrity tag.
 */
export function rewriteWikiImageRefs(
  md: string,
  wikiId: string,
  srcFile: string,
  publicBaseUrl: string,
  secret: string,
): string {
  const srcDir = path.posix.dirname(srcFile.replace(/\\/g, '/'))
  return md.replace(MD_IMAGE_RE, (whole, head, pre, url, tail) => {
    if (isAbsoluteRef(url)) return whole
    // Resolve the image path relative to the markdown file's dir, then
    // normalise to a wiki-root-relative POSIX path.
    const joined = path.posix.normalize(
      path.posix.join(srcDir === '.' ? '' : srcDir, url),
    )
    // Reject traversal out of the wiki root (mirrors the serving route's guard).
    if (joined.startsWith('..') || path.posix.isAbsolute(joined)) return whole
    const token = encodeResourceToken(wikiId, joined, secret)
    const filename = path.posix.basename(joined) || 'asset'
    const uri = `${publicBaseUrl}${RESOURCE_PREFIX}/${token}/${encodeURIComponent(filename)}`
    return `${head}${pre}${uri}${tail}`
  })
}
