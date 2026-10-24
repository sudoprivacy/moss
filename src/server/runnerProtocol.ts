import type { CohostSessionBinding } from './runtime/cohostSessionRepository.js'

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
  | { type: 'pause_input'; pauseId: string; requestId: string }
  | { type: 'resume_input'; pauseId: string; requestId: string }

export type RunnerServerMessage =
  | {
      type: 'hello'
      attemptId: string
      sessionId: string
      runtimeType: 'host' | 'docker' | 'k8s' | 'cohost'
      state: string
      inputPauseSupported?: true
      managedProcessId?: string
      cohostSessionBinding?: CohostSessionBinding
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
      isReady: boolean
      attemptId?: string
      isBusy?: boolean
    }
  | {
      type: 'input_paused'
      requestId: string
      attemptId: string
      isInputDrained: boolean
      isReady: boolean
      isBusy?: boolean
    }
  | { type: 'input_resumed'; requestId: string; attemptId: string }
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
