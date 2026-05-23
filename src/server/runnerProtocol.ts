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
