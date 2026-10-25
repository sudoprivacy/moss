import { describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { MossActionExecutor } from '../gateway/MossActionExecutor.js';
import type { ChannelAgentResolver, IChannelAgentOption } from '../gateway/ChannelAgentResolver.js';
import type { PluginManager } from '../gateway/PluginManager.js';
import type { SessionManager } from '../core/SessionManager.js';
import type { PairingService } from '../pairing/PairingService.js';
import type { DirectConnectStore } from '../../server/db.js';
import type { RuntimeService } from '../../server/runtimeService.js';

function fixture(activeAgent?: IChannelAgentOption | null) {
  const owner = 'owner-qa';
  const createSession = mock(async (input: { assistantName?: string }) => {
    // Model the resource lookup that rejected the real Feishu display name.
    if (input.assistantName && input.assistantName !== 'configured-agent') {
      throw new Error('RESOURCE_UNAVAILABLE');
    }
    return { sessionId: 'runtime-qa' };
  });
  const socket = new EventEmitter();
  const store = {
    getChannelPlugin: mock(async () => ({ user_id: owner, org_id: 'org-qa', config_json: '{}' })),
    findChannelSession: mock(async () => null),
    setChannelSessionAgentConfig: mock(async () => undefined),
  };
  const sessions = {
    getSession: () => ({ id: 'channel-session-qa' }),
    updateSessionConversation: mock(async () => undefined),
  };
  const executor = new MossActionExecutor(
    {} as PluginManager,
    sessions as unknown as SessionManager,
    {} as PairingService,
    { createSession, connectInternalChannel: async () => socket } as unknown as RuntimeService,
    store as unknown as DirectConnectStore,
    activeAgent === undefined ? undefined : {
      resolveActiveAgent: async () => activeAgent,
    } as unknown as ChannelAgentResolver,
  );
  return { executor, createSession, store, sessions, owner };
}

describe('channel session Agent identity', () => {
  for (const activeAgent of [undefined, null]) {
    it(`starts an unbound chat through the runtime owner default (${String(activeAgent)})`, async () => {
      const { executor, createSession, store, sessions, owner } = fixture(activeAgent);
      const state = await executor['createRuntimeSession'](
        'lark_qa:feishu-user:chat-qa',
        { id: 'channel-user-qa', platformUserId: 'feishu-user', platformType: 'lark', displayName: 'User d92111', authorizedAt: 1 },
        'lark', 'lark_qa', 'chat-qa', owner,
      );
      expect(state.sessionId).toBe('runtime-qa');
      const input = createSession.mock.calls[0]![0];
      expect(input).not.toHaveProperty('assistantName');
      expect(input).toMatchObject({ userId: owner, orgId: 'org-qa', source: 'lark', channelChatId: 'lark_qa#chat-qa' });
      expect(store.getChannelPlugin).toHaveBeenCalledWith('lark_qa', owner);
      expect(sessions.updateSessionConversation).toHaveBeenCalledWith('channel-session-qa', 'runtime-qa');
    });
  }

  it('retains an explicitly resolved Agent without substituting the sender display name', async () => {
    const { executor, createSession, owner } = fixture({ name: 'configured-agent', displayName: 'Configured Agent' });
    await executor['createRuntimeSession'](
      'lark_qa:feishu-user:chat-qa',
      { id: 'channel-user-qa', platformUserId: 'feishu-user', platformType: 'lark', displayName: 'User d92111', authorizedAt: 1 },
      'lark', 'lark_qa', 'chat-qa', owner,
    );
    expect(createSession.mock.calls[0]![0]).toMatchObject({ assistantName: 'configured-agent', assistantDisplayName: 'Configured Agent', userId: owner });
  });
});
