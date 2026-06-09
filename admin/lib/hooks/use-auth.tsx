'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { getMe, login as apiLogin, loginWithApiKey, logout as apiLogout, isAuthenticated, switchOrg } from '@/lib/api/auth'
import { UNAUTHORIZED_EVENT, removeToken, getPreferredOrgId, setPreferredOrgId } from '@/lib/api/client'
import type { AuthUser } from '@/lib/api/types'

interface AuthContextType {
  user: AuthUser | null
  scopes: string[]
  /** The org the session is currently scoped to. For a super_admin this
   *  reflects the org they've switched into (which differs from user.orgId,
   *  the actor's home org). For everyone else it equals user.orgId. */
  activeOrgId: string | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (username: string, password: string) => Promise<void>
  loginWithKey: (apiKey: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [scopes, setScopes] = useState<string[]>([])
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const checkAuth = useCallback(async () => {
    if (!isAuthenticated()) {
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
          // Preferred org no longer exists/accessible — fall back to current.
        }
      }
      setUser(response.user)
      setScopes(response.scopes)
      setActiveOrgId(response.organization?.id ?? response.user?.orgId ?? null)
    } catch {
      removeToken()
      setUser(null)
      setScopes([])
      setActiveOrgId(null)
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
      setIsLoading(false)
    }

    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
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
        isAuthenticated: !!user,
        login,
        loginWithKey,
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
