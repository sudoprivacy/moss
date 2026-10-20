import { HttpError } from '../httpError.js'
import type { BrowserBinding, BrowserWorkerPort } from './browserGateway.js'

export const browserConversationGuidance = 'Start the browser shared with the user. Choose headless/headful from the task; headless runs no display service and supports the page viewer. Cloud extension is preferred for compatibility and persistent login. Existing browsers retain their launch mode; use browser_restart for an intended mode change. Ask for human help through your native question/options or ordinary conversation. The user uses the existing conversation interrupt and a normal message to continue; do not request separate browser takeover/return buttons. The authenticated host must acknowledge the input barrier and browser lease. While human control is held, wait without using another tool, shell, connection or browser. After continuation, freshly observe and discard old coordinates and queued inputs. The user signs in directly in this same browser/profile; never request passwords, cookies or verification codes in chat.'

export function browserConversationIntent(input: unknown): 'interrupt' | 'continue' {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid browser conversation intent')
  const value = input as Record<string, unknown>
  if ((value.intent !== 'interrupt' && value.intent !== 'continue') || Object.keys(value).some(key => key !== 'intent')) throw new HttpError(400, 'Invalid browser conversation intent')
  return value.intent
}

/** Conversation intent changes the lease without creating a second model turn. */
export async function changeBrowserConversationControl(
  worker: BrowserWorkerPort,
  binding: BrowserBinding,
  controller: string,
  intent: 'interrupt' | 'continue',
): Promise<{ changed: boolean }> {
  const reply = await worker.invoke(binding, controller, { kind: 'state' }) as {
    session: { state: string; controlEpoch: number; targetEpoch: number; isController: boolean; isHumanControlHeld?: boolean }
  }
  const state = reply.session
  if (intent === 'interrupt') {
    if (state.state === 'stopped' || (state.state === 'human' && state.isController)) return { changed: false }
    if (state.state !== 'ai') throw new HttpError(409, 'browser_control_transfer_in_progress')
    await worker.invoke(binding, controller, { kind: 'take', controlEpoch: state.controlEpoch, targetEpoch: state.targetEpoch })
    return { changed: true }
  }
  if (state.state === 'ai' || (state.state === 'stopped' && !state.isHumanControlHeld)) return { changed: false }
  if (!state.isController || !(state.state === 'human' || (state.state === 'stopped' && state.isHumanControlHeld))) {
    throw new HttpError(409, 'browser_control_not_owned')
  }
  // The SDK fences queued input, drains the current operation and observes
  // before releasing this lease. No synthetic user message is sent here.
  await worker.invoke(binding, controller, { kind: 'return', controlEpoch: state.controlEpoch, targetEpoch: state.targetEpoch })
  return { changed: true }
}
