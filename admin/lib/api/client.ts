const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

const TOKEN_KEY = 'moss_access_token'
const REFRESH_TOKEN_KEY = 'moss_refresh_token'
const TOKEN_EXPIRES_KEY = 'moss_token_expires_at'
// Super-admin's last selected org. Persisted across logins (NOT cleared on
// logout) so the same admin returns to the org they were managing.
const PREFERRED_ORG_KEY = 'moss_preferred_org_id'
export const UNAUTHORIZED_EVENT = 'moss:unauthorized'

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

export function getPreferredOrgId(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(PREFERRED_ORG_KEY)
}

export function setPreferredOrgId(orgId: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(PREFERRED_ORG_KEY, orgId)
}

let refreshPromise: Promise<string | null> | null = null

export async function ensureValidToken(): Promise<string | null> {
  const token = getToken()
  if (!token) return null

  const expiresAt = getTokenExpiresAt()
  const buffer = 5 * 60 * 1000

  if (expiresAt && Date.now() < expiresAt - buffer) {
    return token
  }

  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    const refreshToken = getRefreshToken()
    if (!refreshToken) {
      removeToken()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
      }
      return null
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      })

      if (!response.ok) {
        removeToken()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
        }
        return null
      }

      const data = await response.json()
      setToken(data.access_token)
      if (data.refresh_token) {
        setRefreshToken(data.refresh_token)
      }
      setTokenExpiresAt(Date.now() + (data.expires_in || 3600) * 1000)
      return data.access_token
    } catch {
      removeToken()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
      }
      return null
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

interface ApiErrorResponse {
  error: string
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
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

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = getToken()
    const headers = new Headers(options.headers)

    if (
      options.body !== undefined &&
      !(options.body instanceof FormData) &&
      !(options.body instanceof File) &&
      !headers.has('Content-Type')
    ) {
      headers.set('Content-Type', 'application/json')
    }

    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }

    let response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    })

    if (response.status === 401 && token) {
      const newToken = await ensureValidToken()
      if (newToken) {
        const retryHeaders = new Headers(options.headers)
        retryHeaders.set('Authorization', `Bearer ${newToken}`)
        if (
          options.body !== undefined &&
          !(options.body instanceof FormData) &&
          !(options.body instanceof File) &&
          !retryHeaders.has('Content-Type')
        ) {
          retryHeaders.set('Content-Type', 'application/json')
        }
        response = await fetch(`${this.baseUrl}${path}`, {
          ...options,
          headers: retryHeaders,
          credentials: 'include',
        })
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        removeToken()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
        }
      }

      const error = await response.json().catch(() => ({ error: response.statusText }))
      const raw = (error as any).error
      const message = typeof raw === 'string' ? raw : (raw?.message || (error as any).message || 'Request failed')
      throw new ApiRequestError(response.status, message)
    }

    return response.json()
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path)
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
    const token = getToken()
    const headers = new Headers()

    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }

    let response = await fetch(`${this.baseUrl}${path}`, {
      headers,
      credentials: 'include',
    })

    if (response.status === 401 && token) {
      const newToken = await ensureValidToken()
      if (newToken) {
        const retryHeaders = new Headers()
        retryHeaders.set('Authorization', `Bearer ${newToken}`)
        response = await fetch(`${this.baseUrl}${path}`, {
          headers: retryHeaders,
          credentials: 'include',
        })
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        removeToken()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
        }
      }
      throw new ApiRequestError(response.status, response.statusText)
    }

    return response.blob()
  }
}

// Direct backend API calls
export const authClient = new ApiClient(API_BASE_URL)
export const dcClient = new ApiClient(API_BASE_URL)
