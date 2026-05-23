'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { getMe, login as apiLogin, loginWithApiKey, logout as apiLogout, isAuthenticated } from '@/lib/api/auth'
import { UNAUTHORIZED_EVENT } from '@/lib/api/client'
import type { AuthUser } from '@/lib/api/types'

interface AuthContextType {
  user: AuthUser | null
  scopes: string[]
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
  const [isLoading, setIsLoading] = useState(true)

  const checkAuth = useCallback(async () => {
    if (!isAuthenticated()) {
      setUser(null)
      setScopes([])
      setIsLoading(false)
      return
    }

    try {
      const response = await getMe()
      setUser(response.user)
      setScopes(response.scopes)
    } catch {
      localStorage.removeItem('moss_access_token')
      setUser(null)
      setScopes([])
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
    const response = await apiLogin(username, password)
    setUser(response.user)
    setScopes(response.scopes)
  }

  const loginWithKey = async (apiKey: string) => {
    const response = await loginWithApiKey(apiKey)
    setUser(response.user)
    setScopes(response.scopes)
  }

  const logout = async () => {
    await apiLogout()
    setUser(null)
    setScopes([])
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        scopes,
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
