import type { DbDriver, SqlRow } from '../db/driver.js'

/** Shared by SQLite initialization and the versioned PostgreSQL migration. */
export const ACCOUNT_MEMBERSHIP_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS users_id_org_unique ON users (id, org_id);
  CREATE TABLE IF NOT EXISTS human_accounts (
    id TEXT PRIMARY KEY,
    phone TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'disabled')),
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS human_account_memberships (
    account_id TEXT NOT NULL REFERENCES human_accounts(id),
    org_id TEXT NOT NULL REFERENCES organizations(id),
    user_id TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (account_id, org_id),
    FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE ON UPDATE CASCADE
  );
`

export const ACCOUNT_MEMBERSHIP_BACKFILL = `
  INSERT INTO human_accounts (id, phone, status, created_at)
    SELECT u.id, u.phone, 'active', u.created_at FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM human_account_memberships m WHERE m.user_id = u.id)
    ON CONFLICT DO NOTHING;
  INSERT INTO human_account_memberships (account_id, org_id, user_id, created_at)
    SELECT COALESCE((SELECT a.id FROM human_accounts a WHERE a.phone = u.phone), u.id),
      u.org_id, u.id, u.created_at FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM human_account_memberships m WHERE m.user_id = u.id)
    ON CONFLICT DO NOTHING;
`

export interface HumanAccount {
  id: string
  phone: string | null
  status: 'active' | 'locked' | 'disabled'
}

export interface AccountMembership {
  accountId: string
  orgId: string
  userId: string
}

interface ExistingMember {
  id: string
  orgId: string
  phone?: string | null
  createdAt: number
}

function account(row: SqlRow): HumanAccount {
  return { id: String(row.id), phone: row.phone == null ? null : String(row.phone), status: row.status as HumanAccount['status'] }
}

function membership(row: SqlRow): AccountMembership {
  return { accountId: String(row.account_id), orgId: String(row.org_id), userId: String(row.user_id) }
}

/** A human login account owns independent, existing user identities in each organization. */
export class AccountMemberships {
  constructor(private readonly driver: DbDriver) {}

  async findAccountByPhone(phone: string): Promise<HumanAccount | null> {
    const row = await this.driver.get('SELECT id, phone, status FROM human_accounts WHERE phone = ?', [phone])
    return row ? account(row) : null
  }

  async getAccount(id: string): Promise<HumanAccount | null> {
    const row = await this.driver.get('SELECT id, phone, status FROM human_accounts WHERE id = ?', [id])
    return row ? account(row) : null
  }

  async forUser(userId: string): Promise<AccountMembership | null> {
    const row = await this.driver.get('SELECT account_id, org_id, user_id FROM human_account_memberships WHERE user_id = ?', [userId])
    return row ? membership(row) : null
  }

  async inOrganization(accountId: string, orgId: string): Promise<AccountMembership | null> {
    const row = await this.driver.get('SELECT account_id, org_id, user_id FROM human_account_memberships WHERE account_id = ? AND org_id = ?', [accountId, orgId])
    return row ? membership(row) : null
  }

  async listActive(accountId: string): Promise<AccountMembership[]> {
    const rows = await this.driver.all(`SELECT m.account_id, m.org_id, m.user_id
      FROM human_account_memberships m JOIN users u ON u.id = m.user_id AND u.org_id = m.org_id
      JOIN human_accounts a ON a.id = m.account_id
      WHERE m.account_id = ? AND a.status = 'active' AND u.status = 'active'
      ORDER BY m.created_at, m.org_id`, [accountId])
    return rows.map(membership)
  }

  async isActiveForUser(userId: string): Promise<boolean> {
    const link = await this.forUser(userId)
    return !link || (await this.getAccount(link.accountId))?.status === 'active'
  }

  /** Call inside the same transaction that creates the organization member. */
  async attach(accountId: string, user: ExistingMember): Promise<AccountMembership> {
    const owner = await this.getAccount(accountId)
    if (!owner || owner.status !== 'active') throw new Error('Human account is unavailable')
    const existing = await this.forUser(user.id)
    if (existing) {
      if (existing.accountId !== accountId || existing.orgId !== user.orgId) throw new Error('Member account identity is immutable')
      return existing
    }
    await this.driver.run(`INSERT INTO human_account_memberships (account_id, org_id, user_id, created_at)
      VALUES (?, ?, ?, ?)`, [accountId, user.orgId, user.id, user.createdAt])
    return { accountId, orgId: user.orgId, userId: user.id }
  }

  /** Expand legacy single-organization users without moving their data or credentials. */
  async ensureExisting(user: ExistingMember): Promise<AccountMembership> {
    const existing = await this.forUser(user.id)
    if (existing) {
      // Legacy identity migrations may populate a user's verified phone after
      // the initial account backfill. Preserve that identity without creating
      // another account or replacing an established account phone.
      if (user.phone) await this.driver.run('UPDATE human_accounts SET phone = ? WHERE id = ? AND phone IS NULL', [user.phone, existing.accountId])
      return existing
    }
    await this.driver.run(`INSERT INTO human_accounts (id, phone, status, created_at)
      VALUES (?, ?, 'active', ?) ON CONFLICT DO NOTHING`, [user.id, user.phone ?? null, user.createdAt])
    const owner = user.phone ? await this.findAccountByPhone(user.phone) : await this.getAccount(user.id)
    if (!owner) throw new Error('Human account creation did not complete')
    return this.attach(owner.id, user)
  }
}
