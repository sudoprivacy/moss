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
      runtimeType: 'host' | 'docker' | 'k8s'
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
      // Acknowledgement of a 'stdin' message, sent by the daemon right after
      // dispatching the payload (sessionRunnerDaemon #handleClientMessage).
      // Internal consumers (CronService/EventTriggerService) treat a missing
      // ack as "closed before acknowledging".
      type: 'stdin_ack'
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
