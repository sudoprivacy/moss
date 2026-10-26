import { DatabaseSync } from 'node:sqlite'
import { AuthCenterDb, type AuthCenterUser } from '../authCenter/db.js'
import type { AuthContext } from '../auth/token.js'
import { createIdentityTestRepository } from './compatibilityRepositories.js'
import { MossAgentAccess } from '../mossAgentAccess.js'
import { MossImIdentity } from '../mossImIdentity.js'
import type { IUnifiedIncomingMessage } from '../../channels/types.js'

export async function mossImFixture() {
  const raw = new DatabaseSync(':memory:')
  const db = new AuthCenterDb(raw)
  const identities = createIdentityTestRepository(raw, {}, db.driver)
  for (const id of ['org-a', 'org-b']) await db.createOrganization(id, id, 1)
  for (const id of ['owner', 'alice', 'bob', 'foreign']) {
    const user: AuthCenterUser = { id, orgId: id === 'foreign' ? 'org-b' : 'org-a', name: id, email: `${id}@example.test`,
      displayName: null, departmentId: null, role: id === 'owner' ? 'admin' : 'user', status: 'active',
      membershipRevision: 0, localAuth: false, tokenLimit: null, createdAt: 1, passwordHash: null,
      passwordUpdatedAt: null, lastLoginAt: null, extUserId: null }
    await db.createUser(user)
  }
  await db.driver.exec(`CREATE TABLE channel_plugins (id TEXT, user_id TEXT, org_id TEXT, type TEXT, enabled BIGINT,
    config_json TEXT, credentials_json TEXT, updated_at BIGINT, PRIMARY KEY(id, user_id));`)
  await db.driver.run('INSERT INTO channel_plugins VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['lark-qa', 'owner', 'org-a', 'lark', 1, '{"otherSetting":42}', '{"preserve":"private"}', 1])
  const access = new MossAgentAccess(db.driver, id => db.getUserById(id))
  await access.initialize()
  const service = new MossImIdentity(db.driver, identities, access, role => role === 'admin' ? ['*'] : ['sessions:create', 'sessions:attach'])
  await service.initialize()
  const auth = (id: string, overrides: Partial<AuthContext> = {}) => ({ userId: id, orgId: id === 'foreign' ? 'org-b' : 'org-a',
    role: id === 'owner' ? 'admin' : 'user', scopes: ['*'], authApp: 'moss', ...overrides }) as AuthContext
  await service.configure(auth('owner'), 'lark-qa', 'owner', 'cli_testMoss', 'tenantqa123')
  const connection = (await service.connection('lark-qa', 'owner', 'cli_testMoss'))!
  await access.setAccess(auth('owner'), 'alice', true)
  await access.setAccess(auth('owner'), 'bob', true)
  return { raw, db, service, access, auth, connection }
}

export function mossImMessage(senderId = 'feishu-alice', id = 'message-a', chatId = 'chat-group'): IUnifiedIncomingMessage {
  return { id, platform: 'lark', chatId, user: { id: senderId, displayName: 'QA member' }, content: { type: 'text', text: 'hello' }, timestamp: 1,
    raw: { event: { sender: { sender_type: 'user', tenant_key: 'tenantqa123', sender_id: { user_id: senderId } },
      message: { message_id: id, chat_id: chatId, chat_type: 'group' } } } }
}
