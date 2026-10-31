import type { IReviewInboxItem, IReviewSubscription, ISudographReviewStore } from '@sudowork/sudograph-runtime'
import type { DbDriver, SqlRow } from '../db/driver.js'

function subscription(row: SqlRow): IReviewSubscription {
  return { id: String(row.binding_id ?? row.id), workspaceId: String(row.workspace_id),
    conversationId: String(row.conversation_id), account: String(row.account), shareId: String(row.share_id) }
}

function sameSubscription(left: IReviewSubscription, right: IReviewSubscription) {
  return left.id === right.id && left.workspaceId === right.workspaceId && left.conversationId === right.conversationId
    && left.account === right.account && left.shareId === right.shareId
}

/** Async adapter for the published shared comment provider, scoped to one organization. */
export class OntologyReviewStore implements ISudographReviewStore {
  constructor(private readonly driver: DbDriver, private readonly orgId: string) {
    if (!orgId) throw new Error('A review store requires an organization')
  }

  async getHostValue<T>(key: string): Promise<T | null> {
    const row = await this.driver.get('SELECT value_json FROM ontology_review_values WHERE org_id = ? AND key = ?', [this.orgId, key])
    return row ? JSON.parse(String(row.value_json)) as T : null
  }

  async setHostValue(key: string, value: unknown): Promise<void> {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Invalid review host value')
    await this.driver.run(`INSERT INTO ontology_review_values (org_id,key,value_json) VALUES (?,?,?)
      ON CONFLICT (org_id,key) DO UPDATE SET value_json=excluded.value_json`, [this.orgId, key, encoded])
  }

  async subscribeReview(value: IReviewSubscription): Promise<void> {
    await this.driver.transaction(async () => {
      await this.driver.run(`INSERT INTO ontology_review_subscriptions (org_id,id,workspace_id,conversation_id,account,share_id)
        VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [this.orgId, value.id, value.workspaceId, value.conversationId, value.account, value.shareId])
      const row = await this.driver.get('SELECT * FROM ontology_review_subscriptions WHERE org_id=? AND id=?', [this.orgId, value.id])
      if (!row || !sameSubscription(subscription(row), value)) throw new Error('Review subscription cannot be rebound or duplicated')
    })
  }

  async reviewSubscriptions(workspaceId: string, shareId: string): Promise<IReviewSubscription[]> {
    const rows = await this.driver.all(`SELECT * FROM ontology_review_subscriptions
      WHERE org_id=? AND workspace_id=? AND share_id=? ORDER BY id`, [this.orgId, workspaceId, shareId])
    return rows.map(subscription)
  }

  async acceptReviewEvents(items: Array<{ id: string; subscription: IReviewSubscription; event: IReviewInboxItem['event']; messageId: string }>): Promise<void> {
    await this.driver.transaction(async () => {
      for (const item of items) {
        const row = await this.driver.get('SELECT * FROM ontology_review_subscriptions WHERE org_id=? AND id=?', [this.orgId, item.subscription.id])
        if (!row || !sameSubscription(subscription(row), item.subscription) || item.event.share_id !== item.subscription.shareId) {
          throw new Error('Review event subscription is unavailable')
        }
        const { id, share_id, comment_id, parent_id, event_type, actor_role } = item.event
        const payload = JSON.stringify({ id, share_id, comment_id, parent_id, event_type, actor_role })
        await this.driver.run(`INSERT INTO ontology_review_inbox
          (org_id,id,subscription_id,event_id,payload_json,message_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
        [this.orgId, item.id, item.subscription.id, id, payload, item.messageId, Date.now()])
        const stored = await this.driver.get('SELECT * FROM ontology_review_inbox WHERE org_id=? AND id=?', [this.orgId, item.id])
        if (!stored || stored.subscription_id !== item.subscription.id || stored.event_id !== id
          || stored.payload_json !== payload || stored.message_id !== item.messageId) throw new Error('Review event cannot be rebound')
      }
    })
  }

  async reviewInbox(account: string): Promise<IReviewInboxItem[]> {
    const rows = await this.driver.all(`SELECT i.id,i.payload_json,i.status,i.message_id,s.id AS binding_id,
      s.workspace_id,s.conversation_id,s.account,s.share_id FROM ontology_review_inbox i
      JOIN ontology_review_subscriptions s ON i.org_id=s.org_id AND i.subscription_id=s.id
      WHERE i.org_id=? AND s.account=? AND i.status IN ('pending','running','error') ORDER BY i.created_at,i.id`, [this.orgId, account])
    return rows.map(row => ({ id: String(row.id), event: JSON.parse(String(row.payload_json)) as IReviewInboxItem['event'],
      status: String(row.status), messageId: String(row.message_id), subscription: subscription(row) }))
  }

  async finishReviewEvent(id: string, status: 'running' | 'delivered' | 'error' | 'ignored', error: string | null = null): Promise<void> {
    const changed = await this.driver.run('UPDATE ontology_review_inbox SET status=?,error=? WHERE org_id=? AND id=?', [status, error, this.orgId, id])
    if (!changed) throw new Error('Review inbox item is unavailable')
  }

  async claimReviewInput(id: string, digest: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid review input digest')
    return this.driver.transaction(async () => {
      const item = await this.driver.get('SELECT subscription_id FROM ontology_review_inbox WHERE org_id=? AND id=?', [this.orgId, id])
      if (!item) throw new Error('Review inbox item is unavailable')
      await this.driver.run(`INSERT INTO ontology_review_input_claims (org_id,subscription_id,input_digest,item_id)
        VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, [this.orgId, String(item.subscription_id), digest, id])
      const claim = await this.driver.get(`SELECT item_id FROM ontology_review_input_claims
        WHERE org_id=? AND subscription_id=? AND input_digest=?`, [this.orgId, String(item.subscription_id), digest])
      if (claim?.item_id === id) return true
      await this.finishReviewEvent(id, 'ignored', 'DUPLICATE_HUMAN_INPUT')
      return false
    })
  }

  /** Reserve execution once; an uncertain native outcome must be reconciled, never replayed. */
  async claimReviewDelivery(id: string): Promise<boolean> {
    const changed = await this.driver.run(`INSERT INTO ontology_review_dispatch_claims (org_id,item_id)
      SELECT org_id,id FROM ontology_review_inbox WHERE org_id=? AND id=? ON CONFLICT DO NOTHING`, [this.orgId, id])
    if (changed) return true
    const item = await this.driver.get('SELECT id FROM ontology_review_inbox WHERE org_id=? AND id=?', [this.orgId, id])
    if (!item) throw new Error('Review inbox item is unavailable')
    return false
  }

  async reviewDeliverySummary(account: string, workspaceId: string, conversationId: string): Promise<Record<string, number>> {
    const rows = await this.driver.all(`SELECT i.status,count(*) AS total FROM ontology_review_inbox i
      JOIN ontology_review_subscriptions s ON i.org_id=s.org_id AND i.subscription_id=s.id
      WHERE i.org_id=? AND s.account=? AND s.workspace_id=? AND s.conversation_id=? GROUP BY i.status`,
    [this.orgId, account, workspaceId, conversationId])
    return Object.fromEntries(rows.map(row => [row.status === 'error' ? 'failed' : String(row.status), Number(row.total)]))
  }
}
