/**
 * Per-(user, service) access-token minter for the auth proxy.
 *
 * Some third-party services don't accept a static credential on each call —
 * they require a short-lived access_token obtained by logging in
 * (username/password → token endpoint → {access_token, expires_in}). The auth
 * proxy injects static secrets but can't mint tokens, so for `config_items`
 * whose `auth_type` is a login-type, this module turns the user's stored
 * credential into a fresh token, caches it per (user, service), and returns it
 * for injection. The credential/token never leaves the server.
 *
 * Two recipes:
 *   - declarative (auth_type oauth2_*): a single token-endpoint POST described
 *     by `token_request_json` (where creds + static params go, and where the
 *     token/expiry live in the response). Covers standard OAuth2-ish logins
 *     with no per-service code.
 *   - script (auth_type 'script'): run the per-service login script (creds via
 *     env), which prints {access_token, expiresIn} — the escape hatch for
 *     signed / multi-step / cookie-based flows. The script path is not
 *     admin-configurable; it is composed by convention as
 *     `<mintScriptsDir>/<pinyin>_mint.sh` so a script can only be installed on
 *     the server by a sysadmin, never pointed at an arbitrary path from the UI.
 */

import { spawn } from 'child_process'
import path from 'path'

const MINT_SAFETY_SEC = 5 * 60 // serve/store with a 5-min buffer before real expiry
const MINT_SKEW_SEC = 60 // re-mint if a cached token has < this left
const SCRIPT_TIMEOUT_MS = 10_000

/** Minimal token store the minter caches into (the authCenter db). */
export interface MintedTokenStore {
  getMintedToken(userId: string, configItemId: number): { token: string; expiresAt: number } | null
  putMintedToken(userId: string, configItemId: number, token: string, expiresAt: number): void
}

/** The login-type config needed to mint, projected from a config_items row. */
export interface MintConfig {
  configItemId: number
  authType: string // 'oauth2_password' | 'oauth2_client' | 'oauth2_refresh' | 'script' | ...
  tokenUrl?: string | null
  tokenRequestJson?: string | null
  // For auth_type 'script': the config item's pinyin and the configured scripts
  // directory. The minter runs `<mintScriptsDir>/<pinyin>_mint.sh` — the path is
  // never taken from user/admin input, so the UI can't point it elsewhere.
  pinyin?: string | null
  mintScriptsDir?: string | null
}

/** Declarative recipe parsed from token_request_json. All fields optional. */
interface TokenRequestRecipe {
  method?: string // default POST
  // where to place params: 'form' (x-www-form-urlencoded, default) | 'json' | 'basic'
  // 'basic' puts the first two cred entries into an HTTP Basic header.
  placement?: 'form' | 'json' | 'basic'
  // static params merged into the request body (client_id, grant_type, scope…)
  params?: Record<string, string>
  // map stored-cred keys → request param names (e.g. {"username":"user","password":"pass"})
  // when absent, cred keys are used as-is.
  cred_map?: Record<string, string>
  // dot-path locators in the JSON response
  token_path?: string // default 'access_token'
  expiry_path?: string // default 'expires_in' (seconds)
  default_ttl_sec?: number // used when expiry_path is absent/missing
}

export class TokenMinter {
  constructor(private readonly store: MintedTokenStore) {}

  /**
   * Return a usable access_token for (userId, service), minting from the
   * stored credentials when the cache is empty/expired. Returns null when no
   * token could be produced (caller → 403 so the skill asks the user to set or
   * refresh the credential).
   */
  async getOrMint(
    userId: string,
    cfg: MintConfig,
    creds: Record<string, string>,
  ): Promise<{ token: string; expiresAt: number } | null> {
    const cached = this.store.getMintedToken(userId, cfg.configItemId)
    const nowSec = Math.floor(Date.now() / 1000)
    if (cached && cached.expiresAt - nowSec >= MINT_SKEW_SEC) {
      return cached
    }
    return this.mintAndStore(userId, cfg, creds)
  }

  /**
   * Mint a fresh token unconditionally (ignoring any cached one) and overwrite
   * the cache. Used when a cached token was accepted by getOrMint's expiry check
   * but the upstream still rejected it with 401 — e.g. the provider enforces a
   * single active session per account, so a login elsewhere silently invalidated
   * our token well before its nominal expiry. getOrMint alone can't recover from
   * that (no time has passed), so the proxy calls this to re-mint and retry once.
   */
  async forceMint(
    userId: string,
    cfg: MintConfig,
    creds: Record<string, string>,
  ): Promise<{ token: string; expiresAt: number } | null> {
    return this.mintAndStore(userId, cfg, creds)
  }

  /** Run the mint recipe, store the result in the cache, and return it. */
  private async mintAndStore(
    userId: string,
    cfg: MintConfig,
    creds: Record<string, string>,
  ): Promise<{ token: string; expiresAt: number } | null> {
    let minted: { token: string; expiresIn: number } | null
    try {
      minted = cfg.authType === 'script'
        ? await this.mintViaScript(cfg, creds)
        : await this.mintViaDeclarative(cfg, creds)
    } catch {
      return null
    }
    if (!minted || !minted.token) return null
    const expiresAt = Math.floor(Date.now() / 1000) + Math.max(1, minted.expiresIn) - MINT_SAFETY_SEC
    this.store.putMintedToken(userId, cfg.configItemId, minted.token, expiresAt)
    return { token: minted.token, expiresAt }
  }

  private async mintViaDeclarative(
    cfg: MintConfig,
    creds: Record<string, string>,
  ): Promise<{ token: string; expiresIn: number } | null> {
    if (!cfg.tokenUrl) return null
    const recipe: TokenRequestRecipe = cfg.tokenRequestJson
      ? (JSON.parse(cfg.tokenRequestJson) as TokenRequestRecipe)
      : {}
    const method = (recipe.method || 'POST').toUpperCase()
    const placement = recipe.placement || 'form'

    // Build the param set: stored creds (renamed via cred_map) + static params.
    const params: Record<string, string> = { ...(recipe.params || {}) }
    for (const [k, v] of Object.entries(creds)) {
      params[recipe.cred_map?.[k] ?? k] = v
    }

    const headers: Record<string, string> = {}
    let body: string | undefined
    if (placement === 'json') {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(params)
    } else if (placement === 'basic') {
      // First two cred entries → Basic header; remaining params go in the form body.
      const credVals = Object.values(creds)
      if (credVals.length >= 2) {
        headers['Authorization'] = 'Basic ' + Buffer.from(`${credVals[0]}:${credVals[1]}`).toString('base64')
      }
      const form = new URLSearchParams(recipe.params || {})
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = form.toString()
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(params).toString()
    }

    const resp = await fetch(cfg.tokenUrl, { method, headers, body })
    if (!resp.ok) return null
    const json = (await resp.json()) as Record<string, unknown>
    const token = getByPath(json, recipe.token_path || 'access_token')
    if (typeof token !== 'string' || !token) return null
    const expRaw = getByPath(json, recipe.expiry_path || 'expires_in')
    const expiresIn = typeof expRaw === 'number'
      ? expRaw
      : typeof expRaw === 'string' && expRaw.trim() && Number.isFinite(Number(expRaw))
        ? Number(expRaw)
        : recipe.default_ttl_sec ?? 3600
    return { token, expiresIn }
  }

  private mintViaScript(
    cfg: MintConfig,
    creds: Record<string, string>,
  ): Promise<{ token: string; expiresIn: number } | null> {
    // The script path is composed by convention, never taken from input:
    // <mintScriptsDir>/<pinyin>_mint.sh. Pinyin is validated at creation to
    // [a-z0-9_-]; re-check here (defense in depth) so a crafted value can't
    // traverse out of the scripts dir.
    const pinyin = cfg.pinyin?.trim()
    if (!pinyin || !/^[a-z0-9_-]+$/i.test(pinyin)) return Promise.resolve(null)
    const dir = cfg.mintScriptsDir?.trim() || '/app/scripts'
    const scriptPath = path.join(dir, `${pinyin}_mint.sh`)
    return new Promise((resolve) => {
      // Creds travel as a single JSON env var (never argv — keeps them out of `ps`).
      const child = spawn(scriptPath, [], {
        env: { ...process.env, MINT_CREDS: JSON.stringify(creds) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let settled = false
      const done = (v: { token: string; expiresIn: number } | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        done(null)
      }, SCRIPT_TIMEOUT_MS)
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      child.on('error', () => done(null))
      child.on('close', (code) => {
        if (code !== 0) return done(null)
        try {
          const json = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() || '{}') as Record<string, unknown>
          const token = typeof json.access_token === 'string'
            ? json.access_token
            : typeof json.accessToken === 'string' ? json.accessToken : ''
          if (!token) return done(null)
          const expiresIn = typeof json.expiresIn === 'number'
            ? json.expiresIn
            : typeof json.expires_in === 'number' ? json.expires_in : 3600
          done({ token, expiresIn })
        } catch {
          done(null)
        }
      })
    })
  }
}

/** Resolve a dotted path (e.g. "data.access_token") in a JSON object. */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}
