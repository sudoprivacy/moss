/**
 * `GET /api/v1/system-config` — the client bootstrap document.
 *
 * ## Why this exists
 *
 * The sudowork client decides *how to log in* by asking the server, not by
 * hard-coding a method: it fetches this document before showing a login screen
 * and renders the panel that `login_method` names. That indirection is what
 * lets one binary and one client serve both Sudo Cloud (we host) and Sudo
 * Private (the customer hosts) — the deployment states its own identity here
 * instead of the client guessing from a URL.
 *
 * It also carries the addresses of the satellite services (sudorouter, skill
 * hub, telemetry, update feed), so a self-hosted deployment can point at its
 * own or at nothing at all, rather than inheriting the public cloud's.
 *
 * ## Sensitivity boundary — read before adding a field
 *
 * This route is **public and unauthenticated**; it is served before any auth
 * gate because the client must read it while logged out. Everything here is
 * world-readable to anyone who can reach the port.
 *
 * Put in it: feature switches, login method, and base URLs.
 * Never put in it: API keys, tokens, secrets, user or org data, internal
 * hostnames that are not already public. The admin-facing counterpart that
 * *does* hold credentials is `systemSettings.ts` — do not confuse the two, and
 * do not widen this payload by spreading a settings object into it.
 *
 * The field names are snake_case because they are a wire contract with the
 * sudowork client's `SystemConfig` interface; moss's own config is camelCase
 * and this module is the only place the two meet.
 */
import type { ServerConfig } from './types.js'

/** Third-party (CAS) provider, as the sudowork client parses it. */
export type PublicThirdPartyProvider = {
  id: string
  name: string
  type: 'cas'
  cas_url: string
  login_path?: string
  validate_path?: string
  logout_path?: string
  logout_service_url?: string
  service_param?: string
  service_encode_mode?: 'raw' | 'component'
  callback_mode?: 'server_callback' | 'direct_app'
  server_callback_url?: string
  app_callback_url?: string
}

export type PublicSystemConfig = {
  login_method: 0 | 1 | 2
  third_party_auth?: {
    enabled: boolean
    default_provider?: string
    providers: PublicThirdPartyProvider[]
  }
  sudorouter_baseurl?: string
  skillhub_baseurl?: string
  scode_auto_model?: string
  recharge_mode: 'pay' | 'approve' | 'disabled'
  credit_application?: {
    min_points: number
    max_points: number
    allow_duplicate_pending: boolean
  }
  log_report?: { enabled: number; baseurl?: string }
  version_update?: { enabled: number; cos_domain?: string }
  product_improvement?: { enabled: number; encryption_required?: boolean }
}

/**
 * The client reads these switches as `enabled !== 0`, i.e. it fails OPEN: a
 * missing or unparsable value keeps the feature on. So "off" has to be said
 * explicitly with a 0 — omitting the block does not disable anything.
 */
function switchValue(enabled: boolean): number {
  return enabled ? 1 : 0
}

/**
 * Strip a trailing `/v1` (and any trailing slashes) from a model-service URL.
 *
 * The system settings store the OpenAI-style endpoint (`…/v1`) because that is
 * what an SDK is handed, but `sudorouter_baseurl` is a ROOT that client call
 * sites append their own paths to (`/v1`, `/search/tavily`,
 * `/api/specific_pricing`). Passing the `/v1` form through unchanged yields
 * `…/v1/v1/...` at every call site.
 */
export function toSudorouterRoot(modelServiceUrl: string | undefined): string | undefined {
  const trimmed = modelServiceUrl?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '') || undefined
}

/**
 * Build the public payload from server config plus the resolved sudorouter
 * endpoint. `modelServiceUrl` is passed in rather than read here so this module
 * stays free of any dependency on the settings store (which holds secrets).
 */
export function buildPublicSystemConfig(
  config: ServerConfig,
  modelServiceUrl?: string,
): PublicSystemConfig {
  const sc = config.systemConfig

  const payload: PublicSystemConfig = {
    login_method: sc.loginMethod,
    recharge_mode: sc.rechargeMode,
  }

  // An explicit override wins; otherwise derive the root from the model service
  // URL the deployment is already using, so the two cannot drift apart.
  const sudorouterRoot = sc.sudorouterBaseUrl?.trim() || toSudorouterRoot(modelServiceUrl)
  if (sudorouterRoot) payload.sudorouter_baseurl = sudorouterRoot
  if (sc.skillhubBaseUrl) payload.skillhub_baseurl = sc.skillhubBaseUrl
  if (sc.scodeAutoModel) payload.scode_auto_model = sc.scodeAutoModel

  if (sc.thirdPartyAuth) {
    const providers: PublicThirdPartyProvider[] = sc.thirdPartyAuth.providers.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      cas_url: p.casUrl,
      ...(p.loginPath ? { login_path: p.loginPath } : {}),
      ...(p.validatePath ? { validate_path: p.validatePath } : {}),
      ...(p.logoutPath ? { logout_path: p.logoutPath } : {}),
      ...(p.logoutServiceUrl ? { logout_service_url: p.logoutServiceUrl } : {}),
      ...(p.serviceParam ? { service_param: p.serviceParam } : {}),
      ...(p.serviceEncodeMode ? { service_encode_mode: p.serviceEncodeMode } : {}),
      ...(p.callbackMode ? { callback_mode: p.callbackMode } : {}),
      ...(p.serverCallbackUrl ? { server_callback_url: p.serverCallbackUrl } : {}),
      ...(p.appCallbackUrl ? { app_callback_url: p.appCallbackUrl } : {}),
    }))
    payload.third_party_auth = {
      enabled: sc.thirdPartyAuth.enabled,
      ...(sc.thirdPartyAuth.defaultProvider
        ? { default_provider: sc.thirdPartyAuth.defaultProvider }
        : {}),
      providers,
    }
  }

  if (sc.creditApplication) {
    payload.credit_application = {
      min_points: sc.creditApplication.minPoints,
      max_points: sc.creditApplication.maxPoints,
      allow_duplicate_pending: sc.creditApplication.allowDuplicatePending,
    }
  }

  // These three are ALWAYS emitted, even when unconfigured, precisely because
  // the client fails open: omitting the block leaves the feature on and pointed
  // at the public cloud's hardcoded fallback host. A self-hosted deployment
  // that says nothing must not silently phone home, so "unset" is serialised as
  // an explicit off. Turning them on is a deliberate act in server.json.
  payload.log_report = {
    enabled: switchValue(sc.logReport?.enabled ?? false),
    ...(sc.logReport?.baseUrl ? { baseurl: sc.logReport.baseUrl } : {}),
  }
  payload.version_update = {
    enabled: switchValue(sc.versionUpdate?.enabled ?? false),
    ...(sc.versionUpdate?.cosDomain ? { cos_domain: sc.versionUpdate.cosDomain } : {}),
  }
  payload.product_improvement = {
    enabled: switchValue(sc.productImprovement?.enabled ?? false),
    ...(sc.productImprovement?.encryptionRequired !== undefined
      ? { encryption_required: sc.productImprovement.encryptionRequired }
      : {}),
  }

  return payload
}
