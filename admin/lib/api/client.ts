const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

const TOKEN_KEY = 'moss_access_token'
const REFRESH_TOKEN_KEY = 'moss_refresh_token'
const TOKEN_EXPIRES_KEY = 'moss_token_expires_at'
// Super-admin's last selected org. Persisted across logins (NOT cleared on
// logout) so the same admin returns to the org they were managing.
const PREFERRED_ORG_KEY = 'moss_preferred_org_id'
export const UNAUTHORIZED_EVENT = 'moss:unauthorized'
export const AUTH_REFRESHED_EVENT = 'moss:auth-refreshed'

export type UnauthorizedReason = 'refresh_missing' | 'refresh_rejected' | 'auth_me_rejected'

interface RefreshedSession {
  access_token: string
  refresh_token?: string
  expires_in?: number
  user?: unknown
  organization?: unknown
  scopes?: string[]
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(TOKEN_KEY, token)
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function setRefreshToken(token: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(REFRESH_TOKEN_KEY, token)
}

export function getTokenExpiresAt(): number | null {
  if (typeof window === 'undefined') return null
  const val = localStorage.getItem(TOKEN_EXPIRES_KEY)
  return val ? Number(val) : null
}

export function setTokenExpiresAt(expiresAt: number): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(TOKEN_EXPIRES_KEY, String(expiresAt))
}

export function removeToken(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXPIRES_KEY)
  // Deliberately keep PREFERRED_ORG_KEY so a super_admin's org selection
  // survives logout/login.
}

function dispatchUnauthorized(reason: UnauthorizedReason): void {
  if (typeof window === 'undefined') return
  const event = typeof CustomEvent === 'function'
    ? new CustomEvent(UNAUTHORIZED_EVENT, { detail: { reason } })
    : new Event(UNAUTHORIZED_EVENT)
  window.dispatchEvent(event)
}

function terminateSession(reason: UnauthorizedReason): void {
  const hadSession = Boolean(getToken() || getRefreshToken())
  removeToken()
  if (hadSession) dispatchUnauthorized(reason)
}

function storeRefreshedSession(data: RefreshedSession): string {
  setToken(data.access_token)
  if (data.refresh_token) setRefreshToken(data.refresh_token)
  setTokenExpiresAt(Date.now() + (data.expires_in || 3600) * 1000)
  if (typeof window !== 'undefined') {
    const event = typeof CustomEvent === 'function'
      ? new CustomEvent(AUTH_REFRESHED_EVENT, { detail: data })
      : new Event(AUTH_REFRESHED_EVENT)
    window.dispatchEvent(event)
  }
  return data.access_token
}

export function getPreferredOrgId(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(PREFERRED_ORG_KEY)
}

export function setPreferredOrgId(orgId: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(PREFERRED_ORG_KEY, orgId)
}

let refreshPromise: Promise<string | null> | null = null

async function responseError(response: Response, fallback: string): Promise<ApiRequestError> {
  const error = await response.json().catch(() => ({ error: fallback }))
  const raw = (error as { error?: unknown }).error
  const message = typeof raw === 'string'
    ? raw
    : ((raw as { message?: unknown } | null)?.message || (error as { message?: unknown }).message || fallback)
  const code = typeof (raw as { code?: unknown } | null)?.code === 'string'
    ? (raw as { code: string }).code
    : undefined
  return new ApiRequestError(response.status, String(message), code)
}

async function refreshSession(baseUrl: string, rejectedAccessToken?: string): Promise<string | null> {
  const currentToken = getToken()
  if (!currentToken) return null
  if (rejectedAccessToken && currentToken !== rejectedAccessToken) return currentToken
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    const refreshToken = getRefreshToken()
    if (!refreshToken) {
      terminateSession('refresh_missing')
      return null
    }

    let response: Response
    try {
      response = await fetch(`${baseUrl}/api/v1/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      })
    } catch (error) {
      throw new ApiRequestError(0, error instanceof Error ? error.message : 'Unable to refresh session', 'AUTH_REFRESH_UNAVAILABLE')
    }

    if (!response.ok) {
      if ([400, 401, 403].includes(response.status)) {
        terminateSession('refresh_rejected')
        return null
      }
      throw await responseError(response, 'Unable to refresh session')
    }

    const data = await response.json().catch(() => null) as RefreshedSession | null
    if (!data?.access_token) {
      throw new ApiRequestError(502, 'Invalid refresh response', 'AUTH_REFRESH_INVALID_RESPONSE')
    }
    return storeRefreshedSession(data)
  })().finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

export async function ensureValidToken(force = false): Promise<string | null> {
  const token = getToken()
  if (!token) return null
  const expiresAt = getTokenExpiresAt()
  const buffer = 5 * 60 * 1000
  if (!force && expiresAt && Date.now() < expiresAt - buffer) return token
  return refreshSession(API_BASE_URL, force ? token : undefined)
}

export function hasScope(scopes: string[], requiredScope: string): boolean {
  return (
    scopes.includes('*') ||
    scopes.includes(requiredScope) ||
    scopes.includes(`${requiredScope.split(':')[0]}:*`)
  )
}

export function hasAnyScope(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.some(scope => hasScope(scopes, scope))
}

export class ApiClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  private headers(options: RequestInit, token: string | null): Headers {
    const headers = new Headers(options.headers)
    if (
      options.body !== undefined &&
      !(options.body instanceof FormData) &&
      !(options.body instanceof File) &&
      !headers.has('Content-Type')
    ) {
      headers.set('Content-Type', 'application/json')
    }
    if (token) headers.set('Authorization', `Bearer ${token}`)
    else headers.delete('Authorization')
    return headers
  }

  private async probeSession(token: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${getToken() ?? token}` },
        credentials: 'include',
      })
      if (response.status === 401) terminateSession('auth_me_rejected')
    } catch {
      // A connectivity failure cannot prove that the session is invalid.
    }
  }

  private async fetchWithAuthRecovery(path: string, options: RequestInit): Promise<Response> {
    const execute = (token: string | null) => fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: this.headers(options, token),
      credentials: 'include',
    })

    const originalToken = getToken()
    let response = await execute(originalToken)
    if (response.status !== 401 || !originalToken) return response

    const recoveredToken = await refreshSession(this.baseUrl, originalToken)
    if (!recoveredToken) return response

    response = await execute(recoveredToken)
    if (response.status === 401) await this.probeSession(recoveredToken)
    return response
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await this.fetchWithAuthRecovery(path, options)

    if (!response.ok) {
      throw await responseError(response, response.statusText || 'Request failed')
    }

    return response.json()
  }

  get<T>(path: string, options: Partial<RequestInit> = {}): Promise<T> {
    return this.request<T>(path, options)
  }

  post<T>(path: string, body?: unknown, options: Partial<RequestInit> = {}): Promise<T> {
    const isFormData = body instanceof FormData
    const isFile = body instanceof File
    return this.request<T>(path, {
      ...options,
      method: 'POST',
      body: body ? (isFormData || isFile ? body as BodyInit : JSON.stringify(body)) : undefined,
    })
  }

  patch<T>(path: string, body?: unknown, options: Partial<RequestInit> = {}): Promise<T> {
    const isFormData = body instanceof FormData
    const isFile = body instanceof File
    return this.request<T>(path, {
      ...options,
      method: 'PATCH',
      body: body ? (isFormData || isFile ? body as BodyInit : JSON.stringify(body)) : undefined,
    })
  }

  put<T>(path: string, body?: unknown, options: Partial<RequestInit> = {}): Promise<T> {
    const isFormData = body instanceof FormData
    const isFile = body instanceof File
    return this.request<T>(path, {
      ...options,
      method: 'PUT',
      body: body ? (isFormData || isFile ? body as BodyInit : JSON.stringify(body)) : undefined,
    })
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, {
      method: 'DELETE',
    })
  }

  async getBlob(path: string): Promise<Blob> {
    const response = await this.fetchWithAuthRecovery(path, {})

    if (!response.ok) {
      throw new ApiRequestError(response.status, response.statusText)
    }

    return response.blob()
  }
}

// Direct backend API calls
export const authClient = new ApiClient(API_BASE_URL)
export const dcClient = new ApiClient(API_BASE_URL)
