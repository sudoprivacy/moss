'use client'

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/hooks/use-auth'
import { requestPhoneCode } from '@/lib/api/auth'
import { ApiRequestError } from '@/lib/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Shield, Loader2 } from 'lucide-react'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginMethod, setLoginMethod] = useState<'password' | 'phone'>('password')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [isSendingCode, setIsSendingCode] = useState(false)
  const [isCodeSent, setIsCodeSent] = useState(false)
  const [resendAt, setResendAt] = useState(0)
  const [resendSeconds, setResendSeconds] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const { login, loginWithPhone, isAuthenticated, isLoading: isCheckingAuth } = useAuth()
  const isBusy = isLoading || isSendingCode

  useEffect(() => {
    if (resendSeconds <= 0) return
    const timer = window.setTimeout(() => setResendSeconds(Math.max(0, Math.ceil((resendAt - Date.now()) / 1000))), 1000)
    return () => window.clearTimeout(timer)
  }, [resendAt, resendSeconds])

  function startCooldown(seconds: number) {
    setResendAt(Date.now() + seconds * 1000)
    setResendSeconds(seconds)
  }

  async function onSendCode() {
    if (isBusy || resendSeconds > 0 || !phone.trim()) return
    setIsSendingCode(true)
    setError('')
    try {
      const result = await requestPhoneCode(phone)
      startCooldown(result.nextSendIn)
      setIsCodeSent(true)
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 429) {
        startCooldown(reason.retryAfterSeconds ?? 60)
      }
      setError(reason instanceof Error ? reason.message : '发送验证码失败')
    } finally {
      setIsSendingCode(false)
    }
  }

  useEffect(() => {
    if (!isCheckingAuth && isAuthenticated) {
      navigate('/', { replace: true })
    }
  }, [isAuthenticated, isCheckingAuth, navigate])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isBusy) return
    setIsLoading(true)
    setError('')

    try {
      if (loginMethod === 'phone') await loginWithPhone(phone, code)
      else await login(username, password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setIsLoading(false)
    }
  }

  if (!isCheckingAuth && isAuthenticated) {
    return null
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4">
          <div className="flex items-center justify-center gap-3">
            <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Shield className="size-6" />
            </div>
          </div>
          <div className="text-center">
            <CardTitle className="text-2xl">企业中控平台</CardTitle>
            <CardDescription className="mt-2">输入您的账号信息登录</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={loginMethod} onValueChange={(value) => {
            if (value !== 'password' && value !== 'phone') return
            setLoginMethod(value)
            setError('')
            setPassword('')
            setCode('')
          }} className="mb-4">
            <TabsList className="grid w-full grid-cols-2" aria-label="登录方式">
              <TabsTrigger value="password" disabled={isBusy}>密码登录</TabsTrigger>
              <TabsTrigger value="phone" disabled={isBusy}>手机验证码登录</TabsTrigger>
            </TabsList>
          </Tabs>
          <form onSubmit={onSubmit} className="space-y-4" aria-busy={isBusy}>
            {error && (
              <div role="alert" className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
                {error}
              </div>
            )}
            {loginMethod === 'phone' ? <>
              <div className="space-y-2">
                <Label htmlFor="phone">手机号</Label>
                <Input id="phone" type="tel" autoComplete="tel" placeholder="输入已注册的手机号"
                  value={phone} disabled={isBusy} required maxLength={32}
                  onChange={(event) => { setPhone(event.target.value); setCode(''); setIsCodeSent(false); setError('') }} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="code">短信验证码</Label>
                <div className="flex gap-2">
                  <Input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
                    maxLength={6} placeholder="6 位验证码" value={code} disabled={isBusy} required
                    onChange={(event) => setCode(event.target.value)} />
                  <Button type="button" variant="outline" onClick={() => void onSendCode()}
                    disabled={isBusy || !phone.trim() || resendSeconds > 0}>
                    {isSendingCode ? '发送中…' : resendSeconds > 0 ? `${resendSeconds} 秒后重发` : '发送验证码'}
                  </Button>
                </div>
                {isCodeSent ? <p role="status" className="text-sm text-muted-foreground">验证码已发送，请查收短信。</p> : null}
              </div>
            </> : <><div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                type="text"
                placeholder="admin"
                value={username}
                autoComplete="username"
                disabled={isBusy}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                placeholder="输入密码"
                value={password}
                autoComplete="current-password"
                disabled={isBusy}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div></>}
            <Button type="submit" className="w-full" disabled={isBusy || (loginMethod === 'phone' && !/^[0-9]{6}$/.test(code.trim()))}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              登录
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
