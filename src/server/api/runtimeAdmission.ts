import type { AuthContext } from '../auth/token.js'
import type { AuthService } from '../auth/service.js'
import { HttpError } from '../httpError.js'
import type { RuntimeAdmissionPauses } from '../runtime/runtimeAdmissionPauses.js'

const ROOT = '/api/v1/admin/runtime-admission'
const PAUSE = /^\/api\/v1\/admin\/runtime-admission\/pauses\/([0-9a-f-]{36})$/i

export function isRuntimeAdmissionRoute(pathname: string): boolean {
  return pathname === ROOT || PAUSE.test(pathname)
}

/** Instance-bound controls; organization administrators cannot pause compute. */
export async function dispatchRuntimeAdmission(
  auth: AuthContext,
  method: string,
  pathname: string,
  body: Record<string, unknown>,
  context: {
    authService: Pick<AuthService, 'requireSuperAdmin'>
    instanceId: string
    pauses: RuntimeAdmissionPauses
    countLiveOtherInstances(): Promise<number>
  },
) {
  await context.authService.requireSuperAdmin(auth)
  if (method === 'GET' && pathname === ROOT) return { status: 200, body: context.pauses.snapshot() }
  const pause = pathname.match(PAUSE)
  if (pause && (method === 'PUT' || method === 'DELETE')) {
    if (body.instanceId !== context.instanceId || body.epochId !== context.pauses.snapshot().epochId) throw new HttpError(409, 'Controller instance changed')
    if (method === 'PUT' && await context.countLiveOtherInstances()) throw new HttpError(409, 'Drain peer Moss controllers before pausing this controller')
    const state = method === 'PUT' ? await context.pauses.pause(pause[1]!) : await context.pauses.resume(pause[1]!)
    return { status: state.isInputDrained === false ? 409 : 200, body: state }
  }
  throw new HttpError(405, 'Method not allowed')
}
