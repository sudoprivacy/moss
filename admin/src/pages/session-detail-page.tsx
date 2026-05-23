'use client'

import { useCallback, useEffect, useState } from 'react'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getSessionContext, resumeSession, terminateSession } from '@/lib/api/sessions'
import { getUsers } from '@/lib/api/auth'
import type { GetSessionContextResponse, AuthUser, SessionMessage, ContentBlock } from '@/lib/api/types'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Loader2, Play, Power, Clock, Server, Container, Wrench, AlertCircle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

// Helper function to extract text content from message
// Transcript messages have format: { type, message: { content } }
// We need to handle both formats for compatibility
function extractMessageText(message: SessionMessage): string {
  if (!message) return ''

  const msg = message as Record<string, unknown>
  const innerMessage = msg.message as Record<string, unknown> | undefined

  // Handle transcript format: message.message.content
  if (innerMessage && 'content' in innerMessage) {
    const content = innerMessage.content

    // String content
    if (typeof content === 'string') {
      return content
    }

    // Array content blocks - extract ALL content types
    if (Array.isArray(content)) {
      const parts: string[] = []

      for (const block of content as ContentBlock[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        } else if (block.type === 'tool_use') {
          const toolBlock = block as Record<string, unknown>
          const name = toolBlock.name || 'unknown'
          const input = toolBlock.input
          const inputStr = input
            ? JSON.stringify(input, null, 2)
            : ''
          parts.push(`🔧 工具调用: ${name}\n${inputStr}`)
        } else if (block.type === 'tool_result') {
          const resultBlock = block as Record<string, unknown>
          const toolContent = resultBlock.content
          const isError = resultBlock.is_error === true
          const header = isError ? '❌ 工具结果 (错误)' : '✅ 工具结果'
          if (typeof toolContent === 'string') {
            const displayContent = toolContent.length > 2000
              ? toolContent.slice(0, 2000) + '...(已截断)'
              : toolContent
            parts.push(`${header}\n${displayContent}`)
          } else if (Array.isArray(toolContent)) {
            // Handle array content in tool_result
            const arrStr = JSON.stringify(toolContent, null, 2)
            const displayContent = arrStr.length > 2000
              ? arrStr.slice(0, 2000) + '...(已截断)'
              : arrStr
            parts.push(`${header}\n${displayContent}`)
          } else {
            parts.push(header)
          }
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          const thinkingBlock = block as Record<string, unknown>
          if (typeof thinkingBlock.thinking === 'string') {
            parts.push(`💭 思考过程:\n${thinkingBlock.thinking}`)
          }
        }
      }

      return parts.join('\n\n---\n\n').trim()
    }
  }

  // Handle direct content format: message.content
  if (typeof message.content === 'string') {
    return message.content
  }

  // Handle array content blocks
  if (Array.isArray(message.content)) {
    const parts: string[] = []
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
    return parts.join('\n\n').trim()
  }

  // Handle legacy tool_use messages
  if (message.type === 'tool_use') {
    const inputStr = message.input
      ? JSON.stringify(message.input, null, 2)
      : ''
    return `🔧 工具调用: ${message.tool_name || 'unknown'}\n${inputStr}`
  }

  // Handle legacy tool_result messages
  if (message.type === 'tool_result') {
    const content = message.content
    const header = message.is_error ? '❌ 工具结果 (错误)' : '✅ 工具结果'
    if (typeof content === 'string') {
      const displayContent = content.length > 2000
        ? content.slice(0, 2000) + '...(已截断)'
        : content
      return `${header}\n${displayContent}`
    }
    return header
  }

  return ''
}

// Get role label for message
// Transcript messages use message.type for 'user'/'assistant', not separate role field
// A message may contain both text and tool blocks - show primary role
function getRoleLabel(message: SessionMessage): string {
  const msg = message as Record<string, unknown>
  const type = msg.type as string

  // Check content types to determine primary role
  const innerMessage = msg.message as Record<string, unknown> | undefined
  if (innerMessage?.content && Array.isArray(innerMessage.content)) {
    const blocks = innerMessage.content as ContentBlock[]
    const hasText = blocks.some(b => b.type === 'text')
    const hasToolUse = blocks.some(b => b.type === 'tool_use')
    const hasToolResult = blocks.some(b => b.type === 'tool_result')

    // If only tool blocks, show tool role
    if (!hasText && hasToolUse) return '工具调用'
    if (!hasText && hasToolResult) return '工具结果'
    // If has text plus tools, show user/assistant role
  }

  // Legacy format
  if (message.type === 'tool_use') return '工具调用'
  if (message.type === 'tool_result') return '工具结果'

  // Transcript format: type indicates role
  if (type === 'user') return '用户'
  if (type === 'assistant') return '助手'

  // Direct role field (fallback)
  if (message.role === 'user') return '用户'
  if (message.role === 'assistant') return '助手'

  return '系统'
}

// Check if message contains tool-related blocks
function isToolMessage(message: SessionMessage): boolean {
  const msg = message as Record<string, unknown>

  // Legacy format
  if (message.type === 'tool_use' || message.type === 'tool_result') {
    return true
  }

  // Transcript format: check for tool blocks in content
  const innerMessage = msg.message as Record<string, unknown> | undefined
  if (innerMessage?.content && Array.isArray(innerMessage.content)) {
    for (const block of innerMessage.content as ContentBlock[]) {
      if (block.type === 'tool_use' || block.type === 'tool_result') {
        return true
      }
    }
  }

  return false
}

// Check if tool result has error
function isToolError(message: SessionMessage): boolean {
  const msg = message as Record<string, unknown>

  // Legacy format
  if (message.type === 'tool_result' && message.is_error === true) {
    return true
  }

  // Transcript format: check for tool_result with is_error
  const innerMessage = msg.message as Record<string, unknown> | undefined
  if (innerMessage?.content && Array.isArray(innerMessage.content)) {
    for (const block of innerMessage.content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        const isError = (block as Record<string, unknown>).is_error as boolean | undefined
        return isError === true
      }
    }
  }

  return false
}

// Check if message is from user (for layout positioning)
function isUserMessage(message: SessionMessage): boolean {
  const msg = message as Record<string, unknown>
  const type = msg.type as string

  // Transcript format: type indicates role
  if (type === 'user') return true
  if (type === 'assistant') return false

  // Legacy format with role field
  if (message.role === 'user') return true
  if (message.role === 'assistant') return false

  return false
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  active: { label: '进行中', variant: 'default' },
  creating: { label: '创建中', variant: 'secondary' },
  detached: { label: '已断开', variant: 'outline' },
  ended: { label: '已结束', variant: 'secondary' },
  terminated: { label: '已终止', variant: 'destructive' },
  failed: { label: '失败', variant: 'destructive' },
  lost: { label: '丢失', variant: 'destructive' },
}

const lifecycleEvents = [
  { status: 'creating', label: '会话创建', description: '会话已创建，等待 runtime 启动' },
  { status: 'active', label: '运行时就绪', description: 'Runtime 已启动并可接受连接' },
  { status: 'detached', label: '已断开', description: '无活跃连接，runtime 仍在运行' },
  { status: 'ended', label: '正常结束', description: '会话正常结束' },
  { status: 'terminated', label: '已终止', description: '会话被强制终止' },
  { status: 'failed', label: '失败', description: '运行时启动失败' },
  { status: 'lost', label: '丢失', description: 'Runtime 无法访问' },
]

interface SessionDetailPageProps {
  sessionId: string
}

export function SessionDetailPage({ sessionId }: SessionDetailPageProps) {
  const [data, setData] = useState<GetSessionContextResponse | null>(null)
  const [users, setUsers] = useState<AuthUser[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isResuming, setIsResuming] = useState(false)
  const [isTerminating, setIsTerminating] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const [contextRes, usersRes] = await Promise.all([
        getSessionContext(sessionId),
        getUsers(),
      ])
      setData(contextRes)
      setUsers(usersRes.users)
    } catch (error) {
      console.error('Failed to fetch session:', error)
      toast.error('获取会话详情失败')
    } finally {
      setIsLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const handleResume = async () => {
    setIsResuming(true)
    try {
      const response = await resumeSession(sessionId)
      toast.success('会话已恢复')
      if (response.ws_url) {
        window.open(response.ws_url, '_blank', 'noopener,noreferrer')
      }
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复会话失败')
    } finally {
      setIsResuming(false)
    }
  }

  const handleTerminate = async () => {
    if (!confirm('确定要终止这个会话吗？')) return
    setIsTerminating(true)
    try {
      await terminateSession(sessionId)
      toast.success('会话已终止')
      await fetchData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '终止会话失败')
    } finally {
      setIsTerminating(false)
    }
  }

  const getUserName = (userId: string) => {
    const user = users.find((u) => u.id === userId)
    return user?.name || userId.slice(0, 8)
  }

  if (isLoading) {
    return (
      <DashboardLayout title="会话详情">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  if (!data) {
    return (
      <DashboardLayout title="会话详情">
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">会话不存在</p>
        </div>
      </DashboardLayout>
    )
  }

  const { session, usage, context } = data
  const statusInfo = statusConfig[session.status] || { label: session.status, variant: 'outline' as const }

  const canResume = ['ended', 'terminated', 'failed', 'lost'].includes(session.status)
  const canTerminate = ['active', 'creating', 'detached'].includes(session.status)

  return (
    <DashboardLayout title="会话详情" description={`Session ID: ${session.sessionId}`}>
      <div className="space-y-6">
        {/* Action Buttons */}
        <div className="flex gap-2">
          {canResume && (
            <Button onClick={handleResume} disabled={isResuming}>
              {isResuming ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Play className="size-4 mr-2" />
              )}
              恢复会话
            </Button>
          )}
          {canTerminate && (
            <Button variant="destructive" onClick={handleTerminate} disabled={isTerminating}>
              {isTerminating ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Power className="size-4 mr-2" />
              )}
              终止会话
            </Button>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Session Info */}
          <Card>
            <CardHeader>
              <CardTitle>会话信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Avatar className="size-10">
                  <AvatarFallback className="bg-primary/10 text-primary">
                    {getUserName(session.userId).slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{getUserName(session.userId)}</p>
                  <p className="text-sm text-muted-foreground font-mono">{session.userId.slice(0, 12)}...</p>
                </div>
              </div>

              <div className="grid gap-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">状态</span>
                  <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">期望状态</span>
                  <Badge variant="outline">{session.desiredState}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">用户角色</span>
                  <span>{session.role}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">创建时间</span>
                  <span>{new Date(session.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">最后活跃</span>
                  <span>{new Date(session.lastActiveAt).toLocaleString('zh-CN')}</span>
                </div>
                {session.endedAt && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">结束时间</span>
                    <span>{new Date(session.endedAt).toLocaleString('zh-CN')}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Docker Runtime Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Container className="size-4" />
                Docker 运行时
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">类型</span>
                  <Badge variant="secondary">{session.runtime.type}</Badge>
                </div>
                {session.runtime.dockerImage && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">镜像</span>
                    <span className="text-right text-xs font-mono">{session.runtime.dockerImage}</span>
                  </div>
                )}
                {session.runtime.dockerMode && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">模式</span>
                    <Badge variant="outline">{session.runtime.dockerMode}</Badge>
                  </div>
                )}
                {session.runtime.containerName && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">容器名</span>
                    <span className="text-right text-xs font-mono">{session.runtime.containerName}</span>
                  </div>
                )}
                {session.runtime.configDir && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ConfigDir</span>
                    <span className="text-right text-xs font-mono truncate max-w-[180px]" title={session.runtime.configDir}>
                      {session.runtime.configDir}
                    </span>
                  </div>
                )}
                {session.workDir && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">工作目录</span>
                    <span className="text-right text-xs font-mono truncate max-w-[180px]" title={session.workDir}>
                      {session.workDir}
                    </span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Usage Stats */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Server className="size-4" />
                使用统计
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 grid-cols-2">
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-sm text-muted-foreground">输入 Token</p>
                  <p className="text-xl font-bold">{usage.inputTokens.toLocaleString()}</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-sm text-muted-foreground">输出 Token</p>
                  <p className="text-xl font-bold">{usage.outputTokens.toLocaleString()}</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-sm text-muted-foreground">总 Token</p>
                  <p className="text-xl font-bold">{usage.totalTokens.toLocaleString()}</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-sm text-muted-foreground">费用</p>
                  <p className="text-xl font-bold">${usage.costUSD.toFixed(4)}</p>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">缓存读取</span>
                  <span>{usage.cacheReadInputTokens.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">缓存创建</span>
                  <span>{usage.cacheCreationInputTokens.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">助手消息</span>
                  <span>{usage.assistantMessageCount}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">读取文件</span>
                  <span>{usage.filesRead}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Session Lifecycle */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="size-4" />
                会话生命周期
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {lifecycleEvents.map((event) => {
                  const isCurrentOrPast = lifecycleEvents.findIndex(e => e.status === session.status) >= lifecycleEvents.findIndex(e => e.status === event.status)
                  const isCurrent = event.status === session.status
                  return (
                    <div
                      key={event.status}
                      className={`flex items-center gap-3 p-2 rounded-md ${
                        isCurrent ? 'bg-primary/10 border border-primary/30' : ''
                      } ${!isCurrentOrPast ? 'opacity-40' : ''}`}
                    >
                      <div className={`size-2 rounded-full ${
                        isCurrent ? 'bg-primary' :
                        isCurrentOrPast ? 'bg-green-500' : 'bg-gray-300'
                      }`} />
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${isCurrent ? 'text-primary' : ''}`}>
                          {event.label}
                          {isCurrent && <span className="ml-2 text-xs">(当前)</span>}
                        </p>
                        <p className="text-xs text-muted-foreground">{event.description}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Messages */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>
                对话历史
                {context.customTitle && <span className="ml-2 text-muted-foreground font-normal">- {context.customTitle}</span>}
              </CardTitle>
              {context.summary && (
                <p className="text-sm text-muted-foreground font-normal mt-1">{context.summary}</p>
              )}
            </CardHeader>
            <CardContent>
              <div className="space-y-4 max-h-[500px] overflow-y-auto">
                {context.messages.length === 0 ? (
                  <p className="text-center py-8 text-muted-foreground">暂无消息记录</p>
                ) : (
                  context.messages.map((message, index: number) => {
                    const text = extractMessageText(message)
                    if (!text && !isToolMessage(message)) return null

                    const roleLabel = getRoleLabel(message)
                    const isTool = isToolMessage(message)
                    const isError = isToolError(message)
                    const isUser = isUserMessage(message)

                    return (
                      <div
                        key={`msg-${index}`}
                        className={`flex ${isUser && !isTool ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-lg p-4 ${
                            isTool
                              ? isError
                                ? 'bg-destructive/10 border border-destructive/30'
                                : 'bg-green-500/10 border border-green-500/30'
                              : isUser
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            {isTool && (
                              isError ? (
                                <AlertCircle className="size-4 text-destructive" />
                              ) : (
                                <CheckCircle2 className="size-4 text-green-600" />
                              )
                            )}
                            <Badge
                              variant={isTool ? 'outline' : isUser ? 'secondary' : 'outline'}
                              className={
                                isUser && !isTool
                                  ? 'bg-primary-foreground/20 text-primary-foreground border-transparent'
                                  : isTool
                                    ? isError
                                      ? 'border-destructive/50 text-destructive'
                                      : 'border-green-500/50 text-green-600'
                                    : ''
                              }
                            >
                              {isTool && <Wrench className="size-3 mr-1" />}
                              {roleLabel}
                            </Badge>
                          </div>
                          <p className="text-sm whitespace-pre-wrap break-words">{text}</p>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  )
}
