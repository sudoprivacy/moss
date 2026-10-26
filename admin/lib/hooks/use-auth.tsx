'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { getMe, login as apiLogin, loginWithApiKey, loginWithPhone as apiLoginWithPhone, logout as apiLogout, isAuthenticated as hasStoredSession, switchOrg } from '@/lib/api/auth'
import { AUTH_REFRESHED_EVENT, UNAUTHORIZED_EVENT, getPreferredOrgId } from '@/lib/api/client'
import type { AuthUser, LoginResponse } from '@/lib/api/types'

interface AuthContextType {
  user: AuthUser | null
  scopes: string[]
  /** The org the session is currently scoped to. For a super_admin this
   *  reflects the org they've switched into (which differs from user.orgId,
   *  the actor's home org). For everyone else it equals user.orgId. */
  activeOrgId: string | null
  isLoading: boolean
  authError: string | null
  isAuthenticated: boolean
  retryAuth: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  loginWithKey: (apiKey: string) => Promise<void>
  loginWithPhone: (phone: string, code: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [scopes, setScopes] = useState<string[]>([])
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)

  const checkAuth = useCallback(async () => {
    setAuthError(null)
    if (!hasStoredSession()) {
      setUser(null)
      setScopes([])
      setActiveOrgId(null)
      setIsLoading(false)
      return
    }

    try {
      let response = await getMe()
      // Restore a super_admin's last-selected org if the current session is
      // scoped elsewhere. Runs once per fresh session (e.g. after login);
      // switchOrg re-issues the token, then we re-read /me.
      const preferred = getPreferredOrgId()
      if (
        response.isSuperAdmin &&
        preferred &&
        response.organization &&
        preferred !== response.organization.id
      ) {
        try {
          await switchOrg(preferred)
          response = await getMe()
        } catch {
          if (!hasStoredSession()) throw new Error('Session was rejected while restoring organization')
          // Preferred org no longer exists/accessible — fall back to current.
        }
      }
      setUser(response.user)
      setScopes(response.scopes)
      setActiveOrgId(response.organization?.id ?? response.user?.orgId ?? null)
    } catch {
      if (!hasStoredSession()) {
        setUser(null)
        setScopes([])
        setActiveOrgId(null)
      } else {
        setAuthError('暂时无法验证登录状态，请检查网络或服务状态后重试。')
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null)
      setScopes([])
      setActiveOrgId(null)
      setAuthError(null)
      setIsLoading(false)
    }

    const handleAuthRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<LoginResponse>).detail
      if (!detail?.user) return
      setUser(detail.user)
      setScopes(detail.scopes ?? [])
      setActiveOrgId(detail.organization?.id ?? detail.user.orgId ?? null)
      setAuthError(null)
    }

    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
    window.addEventListener(AUTH_REFRESHED_EVENT, handleAuthRefreshed)
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
      window.removeEventListener(AUTH_REFRESHED_EVENT, handleAuthRefreshed)
    }
  }, [])

  const login = async (username: string, password: string) => {
    await apiLogin(username, password)
    // checkAuth applies the preferred-org restore + sets activeOrgId.
    await checkAuth()
  }

  const loginWithKey = async (apiKey: string) => {
    await loginWithApiKey(apiKey)
    await checkAuth()
  }

  const loginWithPhone = async (phone: string, code: string) => {
    await apiLoginWithPhone(phone, code)
    await checkAuth()
  }

  const logout = async () => {
    await apiLogout()
    setUser(null)
    setScopes([])
    setActiveOrgId(null)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        scopes,
        activeOrgId,
        isLoading,
        authError,
        isAuthenticated: Boolean(user) || hasStoredSession(),
        retryAuth: checkAuth,
        login,
        loginWithKey,
        loginWithPhone,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
