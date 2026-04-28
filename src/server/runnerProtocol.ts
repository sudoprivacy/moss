export type RunnerClientMessage =
  | {
      type: 'stdin'
      data: string
    }
  | {
      type: 'shutdown'
      force?: boolean
    }
  | {
      type: 'ping'
    }

export type RunnerServerMessage =
  | {
      type: 'hello'
      attemptId: string
      sessionId: string
      runtimeType: 'host' | 'docker'
      state: string
      // Always ACP protocol now
      protocol: 'acp'
    }
  | {
      type: 'stdout'
      line: string
    }
  | {
      type: 'stderr'
      line: string
    }
  | {
      type: 'state'
      state: string
    }
  | {
      type: 'pong'
      ts: number
    }
  | {
      type: 'exit'
      code: number | null
      signal: string | null
    }
  | {
      type: 'error'
      message: string
    }
  | {
      // ACP notification or request from agent
      type: 'acp_notification'
      notification: {
        jsonrpc: '2.0'
        id?: string | number
        method: string
        params?: unknown
      }
    }
