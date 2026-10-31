import type { ISudographReviewGrant, ISudographReviewGrantStore } from '@sudowork/sudograph-runtime'
import { z } from 'zod'
import { contentDigest } from '../agentFederation/provider/protocol.js'
import { ResourceAccessError } from '../catalog/resourceError.js'
import type { DbDriver, SqlRow } from '../db/driver.js'
import type { OntologyProjectRegistry, OntologySessionBinding } from './projectRegistry.js'

const reference = z.string().min(1).max(256)
const metadata = z.object({ shareId: reference.nullable().optional(), revision: reference.optional() }).strict()
const grantShape = z.object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), conversationId: reference,
  authorizationRef: z.string().regex(/^sha256:[a-f0-9]{64}$/), prefix: z.string(), cookieName: z.string(),
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive(),
  shareId: reference.nullable().optional(), revision: reference.optional() }).strict()
const denied = () => new ResourceAccessError(403, 'Canonical review authorization is unavailable')

/** Derived from durable ownership and generation, never from editable model content. */
export function reviewAuthorizationRef(binding: OntologySessionBinding): string {
  return contentDigest({ ...binding, sourceRefs: [...binding.sourceRefs].sort() })
}

function grant(row: SqlRow): ISudographReviewGrant {
  return grantShape.parse({ workspaceId: row.workspace_id, conversationId: row.conversation_id,
    authorizationRef: row.authorization_ref, prefix: row.prefix, cookieName: row.cookie_name,
    credentialHash: row.credential_hash, expiresAt: Number(row.expires_at), shareId: row.share_id,
    ...(row.revision === null ? {} : { revision: row.revision }) })
}

/** Shared SQL capability store. The HTTP host still checks current policy on every request. */
export class OntologyReviewGrantStore implements ISudographReviewGrantStore {
  constructor(private readonly driver: DbDriver,
    private readonly projects: Pick<OntologyProjectRegistry, 'resolveSession'>,
    private readonly now: () => number = Date.now) {}

  async create(id: string, input: ISudographReviewGrant): Promise<void> {
    const parsed = grantShape.safeParse(input)
    if (!/^[a-f0-9]{32}$/.test(id) || !parsed.success) throw new ResourceAccessError(400, 'Invalid review grant')
    const value = parsed.data
    if (value.prefix !== `/review/${id}` || value.cookieName !== `sudograph_review_${id}`
      || value.expiresAt <= this.now() || value.expiresAt > this.now() + 30 * 60_000) {
      throw new ResourceAccessError(400, 'Invalid review grant')
    }
    await this.driver.transaction(async () => {
      const binding = await this.projects.resolveSession(value.conversationId)
      if (!binding || binding.projectId !== value.workspaceId || reviewAuthorizationRef(binding) !== value.authorizationRef) throw denied()
      await this.driver.run('DELETE FROM ontology_review_grants WHERE org_id=? AND user_id=? AND expires_at<=?',
        [binding.orgId, binding.userId, this.now()])
      // SQL uniqueness, rather than a read/count race or process-local lock,
      // bounds concurrent controllers to 128 active grants per current owner.
      for (let slot = 0; slot < 128; slot++) {
        const inserted = await this.driver.run(`INSERT INTO ontology_review_grants
          (id,org_id,user_id,slot,workspace_id,conversation_id,authorization_ref,prefix,cookie_name,credential_hash,expires_at,share_id,revision)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (org_id,user_id,slot) DO NOTHING`,
        [id, binding.orgId, binding.userId, slot, value.workspaceId, value.conversationId, value.authorizationRef,
          value.prefix, value.cookieName, value.credentialHash, value.expiresAt, value.shareId ?? null, value.revision ?? null])
        if (!inserted) continue
        const after = await this.projects.resolveSession(value.conversationId)
        if (!after || reviewAuthorizationRef(after) !== value.authorizationRef) throw denied()
        return
      }
      throw new ResourceAccessError(409, 'Close existing review sessions before opening another')
    })
  }

  async get(id: string): Promise<ISudographReviewGrant | undefined> {
    if (!/^[a-f0-9]{32}$/.test(id)) return undefined
    const row = await this.driver.get('SELECT * FROM ontology_review_grants WHERE id=? AND expires_at>?', [id, this.now()])
    return row ? grant(row) : undefined
  }

  async update(id: string, expected: ISudographReviewGrant, input: Pick<ISudographReviewGrant, 'shareId' | 'revision'>): Promise<boolean> {
    const parsed = metadata.safeParse(input)
    if (!parsed.success) throw new ResourceAccessError(400, 'Invalid review metadata')
    if (!/^[a-f0-9]{32}$/.test(id) || !grantShape.safeParse(expected).success) return false
    const fields = Object.keys(parsed.data) as Array<'shareId' | 'revision'>
    // An empty patch must still verify current immutable identity and expiry.
    const assignments = fields.length ? fields.map(key => key === 'shareId' ? 'share_id=?' : 'revision=?').join(',') : 'id=id'
    const changed = await this.driver.run(`UPDATE ontology_review_grants SET ${assignments}
      WHERE id=? AND workspace_id=? AND conversation_id=? AND authorization_ref=? AND prefix=? AND cookie_name=? AND credential_hash=? AND expires_at=? AND expires_at>?`,
    [...fields.map(key => parsed.data[key] ?? null), id, expected.workspaceId, expected.conversationId, expected.authorizationRef!,
      expected.prefix, expected.cookieName, expected.credentialHash, expected.expiresAt, this.now()])
    return changed === 1
  }

  async delete(id: string): Promise<void> {
    if (/^[a-f0-9]{32}$/.test(id)) await this.driver.run('DELETE FROM ontology_review_grants WHERE id=?', [id])
  }
}
