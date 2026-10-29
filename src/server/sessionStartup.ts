import { randomUUID } from 'node:crypto'
import { ResourceAccessError } from './catalog/resourceError.js'
import { UserRuntimeUpdateRequiredError } from '@sudo/user-runtime'

export interface StartupFailure {
  sessionId?: string
  attemptId: string
  code: string
  isRetryable: boolean
  message: string
}

/** Block model admission until the selected runtime confirms its policy. */
export class EgressPolicyNotAppliedError extends ResourceAccessError {
  constructor(isLocal = false) {
    super(503, `${isLocal ? 'Local runtime' : 'Runtime'} egress policy is not applied; upgrade the runtime or retry delivery`)
    this.name = 'EgressPolicyNotAppliedError'
  }
}

export class SessionStartupError extends Error {
  readonly statusCode: number
  readonly failure: StartupFailure
  constructor(error: unknown, sessionId?: string, attemptId = randomUUID()) {
    const isResource = error instanceof ResourceAccessError
    const isUpdateRequired = error instanceof UserRuntimeUpdateRequiredError
    const isEgressPolicyPending = error instanceof EgressPolicyNotAppliedError
    const message = isEgressPolicyPending
      ? 'Data egress protection is not applied. Retry policy delivery or update the runtime, then try again.'
      : isUpdateRequired
      ? 'Cloud runtime configuration changed. Update the runtime, then send a new message.'
      : isResource
      ? (error.message === 'Bound skill not available' ? 'Bound skill not available. Check the assistant configuration or contact your organization administrator.' : 'Assistant or skill unavailable. Check the configuration or contact your organization administrator.')
      : 'Cloud runtime failed to start. Please retry.'
    // Keep the original error reachable on `cause` for the server log; the
    // API-facing message/failure stay the fixed user-safe text.
    super(message, { cause: error })
    this.name = 'SessionStartupError'
    this.statusCode = isResource ? error.statusCode : 503
    this.failure = { sessionId, attemptId, code: isEgressPolicyPending ? 'EGRESS_POLICY_NOT_APPLIED' : isUpdateRequired ? 'RUNTIME_UPDATE_REQUIRED' : isResource ? 'RESOURCE_UNAVAILABLE' : 'RUNTIME_START_FAILED', isRetryable: isEgressPolicyPending || (!isResource && !isUpdateRequired), message }
  }
}
