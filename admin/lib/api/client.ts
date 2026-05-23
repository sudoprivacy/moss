const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

const TOKEN_KEY = 'moss_access_token'
export const UNAUTHORIZED_EVENT = 'moss:unauthorized'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(TOKEN_KEY, token)
}

export function removeToken(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(TOKEN_KEY)
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

    if (options.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    })

    if (!response.ok) {
      if (response.status === 401) {
        removeToken()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
        }
      }

      const error = await response.json().catch(() => ({ error: response.statusText }))
      const message = (error as ApiErrorResponse).error || 'Request failed'
      throw new ApiRequestError(response.status, message)
    }

    return response.json()
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path)
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, {
      method: 'DELETE',
    })
  }
}

// Direct backend API calls
export const authClient = new ApiClient(API_BASE_URL)
export const dcClient = new ApiClient(API_BASE_URL)
