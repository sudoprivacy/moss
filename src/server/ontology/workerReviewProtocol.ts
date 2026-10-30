import { z } from 'zod'

export const WORKER_REVIEW_PROFILE = 'sudograph-worker-review/v2'
export const WORKER_REVIEW_PROFILE_KEY = 'moss/host-review-profile'

/** Shared host/worker read grammar. No execution path, actor or source is caller selectable. */
const document = z.object({ operation: z.enum(['html', 'document']), endpoint: z.string().regex(/^\/review\/[a-f0-9]{32}\/v1$/) })
const data = z.object({ operation: z.enum(['head', 'graph', 'context', 'page']), params: z.record(z.string(), z.unknown()).optional() })
export const modelReviewRequest = z.union([document.strict(), data.strict()])
// This is a host rendering reference, not a model/source selector. Only the
// trusted host supplies it after resolving its durable project registration.
const hostResource = { resource: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional() }
export const workerReviewRequest = z.union([document.extend(hostResource).strict(), data.extend(hostResource).strict()])
