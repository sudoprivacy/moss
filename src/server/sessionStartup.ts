import { randomUUID } from 'node:crypto'
import { ResourceAccessError } from './catalog/resourceError.js'

export interface StartupFailure {
  sessionId?: string
  attemptId: string
  code: string
  isRetryable: boolean
  message: string
}
export class SessionStartupError extends Error {
  readonly statusCode: number
  readonly failure: StartupFailure
  constructor(error: unknown, sessionId?: string, attemptId = randomUUID()) {
    const isResource = error instanceof ResourceAccessError
    const message = isResource
      ? (error.message === 'Bound skill not available' ? 'Bound skill not available. Check the assistant configuration or contact your organization administrator.' : 'Assistant or skill unavailable. Check the configuration or contact your organization administrator.')
      : 'Cloud runtime failed to start. Please retry.'
    super(message)
    this.name = 'SessionStartupError'
    this.statusCode = isResource ? error.statusCode : 503
    this.failure = { sessionId, attemptId, code: isResource ? 'RESOURCE_UNAVAILABLE' : 'RUNTIME_START_FAILED', isRetryable: !isResource, message }
  }
}
