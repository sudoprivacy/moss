import { randomUUID } from 'node:crypto'
import { ResourceAccessError } from './catalog/resourceError.js'

export interface StartupFailure {
  sessionId?: string
  attemptId: string
  code: string
  isRetryable: boolean
  message: string
}

/**
 * Credential-class startup failures are configuration gaps, not transient
 * faults: the provider /models catalog returned 401 (org/user key missing or
 * rejected, modelProviders.ts) or the shared-billing gate refused for a missing
 * key (runtimeService.ts). Retrying cannot succeed — point the user at their
 * park administrator instead of "please retry". Misses fall back to the
 * default retryable message, so loose matching degrades to the status quo.
 */
function isModelCredentialError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('returned 401 from /models') || message.includes('组织成员模型凭据不可用')
}

export class SessionStartupError extends Error {
  readonly statusCode: number
  readonly failure: StartupFailure
  constructor(error: unknown, sessionId?: string, attemptId = randomUUID()) {
    const isResource = error instanceof ResourceAccessError
    const isCredential = !isResource && isModelCredentialError(error)
    const message = isResource
      ? (error.message === 'Bound skill not available' ? 'Bound skill not available. Check the assistant configuration or contact your organization administrator.' : 'Assistant or skill unavailable. Check the configuration or contact your organization administrator.')
      : isCredential
        ? '模型服务未开通或凭据不可用，请联系园区管理员'
        : 'Cloud runtime failed to start. Please retry.'
    super(message)
    this.name = 'SessionStartupError'
    this.statusCode = isResource ? error.statusCode : 503
    this.failure = { sessionId, attemptId, code: isResource ? 'RESOURCE_UNAVAILABLE' : 'RUNTIME_START_FAILED', isRetryable: !isResource && !isCredential, message }
  }
}
