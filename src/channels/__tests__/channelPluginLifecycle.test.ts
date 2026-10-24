import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IChannelPluginConfig, IUnifiedIncomingMessage, IUnifiedOutgoingMessage } from '../types.js';
import type { DirectConnectStore } from '../../server/db.js';
import type { SessionManager } from '../core/SessionManager.js';

interface IWsOptions {
  onReady: () => void;
  onError: (error: Error) => void;
}

class FakeWsClient {
  static instances: FakeWsClient[] = [];
  static startError: Error | undefined;
  state = 'connecting';
  closeCalls = 0;
  constructor(readonly options: IWsOptions) {
    FakeWsClient.instances.push(this);
  }
  async start(): Promise<void> {
    if (FakeWsClient.startError) throw FakeWsClient.startError;
    // The actual SDK also resolves start() before its connection is ready.
  }
  ready(): void {
    this.state = 'connected';
    this.options.onReady();
  }
  getConnectionStatus() {
    return { state: this.state };
  }
  close(params: { force: boolean }): void {
    expect(params.force).toBe(true);
    this.closeCalls++;
    this.state = 'idle';
  }
}

class FakeDispatcher {
  static instances: FakeDispatcher[] = [];
  handlers: Record<string, (event: Record<string, unknown>) => Promise<unknown>> = {};
  constructor() {
    FakeDispatcher.instances.push(this);
  }
  register(handlers: FakeDispatcher['handlers']): void {
    this.handlers = handlers;
  }
}

mock.module('@larksuiteoapi/node-sdk', () => ({
  Client: class {},
  WSClient: FakeWsClient,
  EventDispatcher: FakeDispatcher,
  Domain: { Feishu: 'feishu' },
  AppType: { SelfBuild: 'self-build' },
  LoggerLevel: { info: 'info' },
}));

const { LarkPlugin } = await import('../plugins/lark/LarkPlugin.js');
const { BasePlugin } = await import('../plugins/BasePlugin.js');
const { PluginManager, registerPlugin } = await import('../gateway/PluginManager.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function config(type = 'lark', id = 'lark_default'): IChannelPluginConfig {
  return {
    id, type, name: id, enabled: true, status: 'stopped', createdAt: 1, updatedAt: 1,
    credentials: { appId: 'cli_0123456789abcdef', appSecret: 'local-test-secret' },
  };
}

const originalCwd = process.cwd();
let tempDirectory: string | undefined;
const ownedPlugins: InstanceType<typeof LarkPlugin>[] = [];

async function createLark() {
  tempDirectory ??= mkdtempSync(join(tmpdir(), 'moss-lark-lifecycle-'));
  process.chdir(tempDirectory);
  const plugin = new LarkPlugin();
  ownedPlugins.push(plugin);
  await plugin.initialize(config());
  return plugin;
}

afterEach(async () => {
  for (const plugin of ownedPlugins.splice(0)) await plugin.stop();
  FakeWsClient.instances = [];
  FakeWsClient.startError = undefined;
  FakeDispatcher.instances = [];
  process.chdir(originalCwd);
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
  tempDirectory = undefined;
});

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Lark long-connection lifecycle', () => {
  it('waits for the handshake, derives connectivity from the SDK and closes on disable', async () => {
    const plugin = await createLark();
    const received: IUnifiedIncomingMessage[] = [];
    plugin.onMessage(async (message) => { received.push(message); });
    const start = plugin.start();
    await nextTurn();
    const ws = FakeWsClient.instances[0];
    expect(plugin.status).toBe('starting');
    expect(plugin.isConnectionReady).toBe(false);
    ws.ready();
    await start;
    expect(plugin.status).toBe('running');
    expect(plugin.isConnectionReady).toBe(true);
    ws.state = 'reconnecting';
    expect(plugin.isConnectionReady).toBe(false);
    ws.state = 'connected';
    expect(plugin.isConnectionReady).toBe(true);
    const dispatcher = FakeDispatcher.instances[0];
    const event = {
      message: { message_id: 'before-stop', message_type: 'text', chat_id: 'oc_test', content: '{"text":"hello"}' },
      sender: { sender_id: { open_id: 'ou_test' } },
    };
    await dispatcher.handlers['im.message.receive_v1'](event);
    await nextTurn();
    expect(received.map((message) => message.content.text)).toEqual(['hello']);
    await plugin.stop();
    expect(ws.closeCalls).toBe(1);
    expect(plugin.isConnectionReady).toBe(false);
    await dispatcher.handlers['im.message.receive_v1']({
      message: { message_id: 'late', message_type: 'text', chat_id: 'oc_test', content: '{"text":"late"}' },
      sender: { sender_id: { open_id: 'ou_test' } },
    });
    await nextTurn();
    expect(received).toHaveLength(1);
  });

  it('propagates SDK start rejection and closes its background client', async () => {
    const plugin = await createLark();
    FakeWsClient.startError = new Error('SDK start rejected');
    await expect(plugin.start()).rejects.toThrow('SDK start rejected');
    expect(plugin.status).toBe('error');
    expect(FakeWsClient.instances[0].closeCalls).toBe(1);
  });

  it('propagates a failed first handshake and ignores a late readiness callback', async () => {
    const plugin = await createLark();
    const start = plugin.start();
    const outcome = start.catch((error: unknown) => error);
    await nextTurn();
    const ws = FakeWsClient.instances[0];
    ws.options.onError(new Error('invalid credentials'));
    expect(await outcome).toBeInstanceOf(Error);
    expect(plugin.error).toBe('invalid credentials');
    ws.ready();
    await nextTurn();
    expect(plugin.status).toBe('error');
    expect(plugin.isConnectionReady).toBe(false);
    expect(ws.closeCalls).toBe(1);
  });

  it('does not overwrite an immediate post-handshake failure with running', async () => {
    const plugin = await createLark();
    const outcome = plugin.start().catch((error: unknown) => error);
    await nextTurn();
    const ws = FakeWsClient.instances[0];
    ws.ready();
    ws.options.onError(new Error('connection lost immediately'));
    expect(await outcome).toBeInstanceOf(Error);
    expect(plugin.status).toBe('error');
    expect(plugin.isConnectionReady).toBe(false);
    expect(ws.closeCalls).toBe(1);
  });

  it('reports a terminal error after readiness and terminates the connection', async () => {
    const plugin = await createLark();
    const start = plugin.start();
    await nextTurn();
    const ws = FakeWsClient.instances[0];
    ws.ready();
    await start;
    ws.options.onError(new Error('retries exhausted'));
    expect(plugin.status).toBe('error');
    expect(plugin.error).toBe('retries exhausted');
    expect(plugin.isConnectionReady).toBe(false);
    expect(ws.closeCalls).toBe(1);
  });

  it('bounds a stalled handshake and closes the retry loop', async () => {
    const plugin = await createLark();
    await expect(plugin.start()).rejects.toThrow('Lark WebSocket connection timed out');
    expect(plugin.status).toBe('error');
    expect(FakeWsClient.instances[0].closeCalls).toBe(1);
  }, 15_000);

  it('rejects an app ID the SDK would silently ignore before starting a client', async () => {
    const plugin = new LarkPlugin();
    await expect(plugin.initialize({ ...config(), credentials: { appId: 'invalid', appSecret: 'test' } }))
      .rejects.toThrow('Invalid Lark App ID');
    expect(FakeWsClient.instances).toHaveLength(0);
  });
});

class ControlledPlugin extends BasePlugin {
  readonly type = 'test-lifecycle';
  static instances: ControlledPlugin[] = [];
  static nextStart = Promise.resolve();
  static isInitializeFailure = false;
  static isStartFailure = false;
  readonly entered = deferred();
  private startGate = ControlledPlugin.nextStart;
  stops = 0;
  constructor() {
    super();
    ControlledPlugin.instances.push(this);
  }
  protected async onInitialize(): Promise<void> {
    if (ControlledPlugin.isInitializeFailure) throw new Error('initialize failure');
  }
  protected async onStart(): Promise<void> {
    this.entered.resolve();
    await this.startGate;
    if (ControlledPlugin.isStartFailure) throw new Error('start failure');
  }
  protected async onStop(): Promise<void> { this.stops++; }
  async sendMessage(_chat: string, _message: IUnifiedOutgoingMessage): Promise<string> { return ''; }
  async editMessage(_chat: string, _id: string, _message: IUnifiedOutgoingMessage): Promise<void> {}
  getActiveUserCount(): number { return 0; }
  getBotInfo() { return null; }
}
registerPlugin('test-lifecycle', ControlledPlugin);

function manager() {
  ControlledPlugin.instances = [];
  ControlledPlugin.nextStart = Promise.resolve();
  ControlledPlugin.isInitializeFailure = false;
  ControlledPlugin.isStartFailure = false;
  const statuses: string[] = [];
  const db = {
    updateChannelPluginStatus: async (_id: string, status: string) => { statuses.push(status); },
  } as unknown as DirectConnectStore;
  return { manager: new PluginManager({} as SessionManager, db), statuses };
}

describe('per-connection lifecycle coordination', () => {
  it('starts the same connection only once while initialization is pending', async () => {
    const { manager: plugins } = manager();
    const gate = deferred();
    ControlledPlugin.nextStart = gate.promise;
    const first = plugins.startPlugin(config('test-lifecycle'), 'test:user');
    const second = plugins.startPlugin(config('test-lifecycle'), 'test:user');
    await nextTurn();
    expect(ControlledPlugin.instances).toHaveLength(1);
    gate.resolve();
    await Promise.all([first, second]);
    await plugins.stopAll();
    expect(ControlledPlugin.instances[0].stops).toBe(1);
  });

  it('finishes a disable requested during startup without leaving a live bot', async () => {
    const { manager: plugins, statuses } = manager();
    const gate = deferred();
    ControlledPlugin.nextStart = gate.promise;
    const start = plugins.startPlugin(config('test-lifecycle'), 'test:user');
    await nextTurn();
    const stop = plugins.stopPlugin('test:user');
    gate.resolve();
    await Promise.all([start, stop]);
    expect(plugins.getPlugin('test:user')).toBeUndefined();
    expect(ControlledPlugin.instances[0].stops).toBe(1);
    expect(statuses).toEqual(['running', 'stopped']);
  });

  it('includes pending starts in shutdown and refuses new starts after shutdown', async () => {
    const { manager: plugins } = manager();
    const gate = deferred();
    ControlledPlugin.nextStart = gate.promise;
    const start = plugins.startPlugin(config('test-lifecycle'), 'test:user');
    await nextTurn();
    const shutdown = plugins.stopAll();
    gate.resolve();
    await Promise.all([start, shutdown]);
    expect(plugins.getAllPlugins()).toHaveLength(0);
    expect(ControlledPlugin.instances[0].stops).toBe(1);
    await expect(plugins.startPlugin(config('test-lifecycle'), 'another:user')).rejects.toThrow('stopping');
  });

  for (const phase of ['initialize', 'start'] as const) {
    it(`cleans up a failed ${phase} and permits a fresh retry`, async () => {
      const { manager: plugins, statuses } = manager();
      ControlledPlugin.isInitializeFailure = phase === 'initialize';
      ControlledPlugin.isStartFailure = phase === 'start';
      await expect(plugins.startPlugin(config('test-lifecycle'), 'test:user')).rejects.toThrow(`${phase} failure`);
      expect(ControlledPlugin.instances[0].stops).toBe(1);
      expect(plugins.getPlugin('test:user')).toBeUndefined();
      ControlledPlugin.isInitializeFailure = false;
      ControlledPlugin.isStartFailure = false;
      await plugins.startPlugin(config('test-lifecycle'), 'test:user');
      expect(statuses).toEqual(['error', 'running']);
      await plugins.stopAll();
    });
  }

  it('keeps an unrelated bot responsive while another connection starts', async () => {
    const { manager: plugins } = manager();
    const gate = deferred();
    ControlledPlugin.nextStart = gate.promise;
    const first = plugins.startPlugin(config('test-lifecycle'), 'first:user');
    await nextTurn();
    ControlledPlugin.nextStart = Promise.resolve();
    await plugins.startPlugin(config('test-lifecycle'), 'second:user');
    expect(plugins.getPlugin('second:user')?.status).toBe('running');
    await plugins.stopPlugin('second:user');
    gate.resolve();
    await first;
    await plugins.stopAll();
  });

  it('coalesces HA lease passes and starts independent connections concurrently', async () => {
    manager();
    const gate = deferred();
    ControlledPlugin.nextStart = gate.promise;
    let claims = 0;
    let reloads = 0;
    const rows = ['first', 'second'].map((id) => ({
      id, type: 'test-lifecycle', name: id, enabled: 1, status: 'stopped',
      user_id: 'user', created_at: 1, updated_at: 1,
    }));
    const db = {
      listChannelPlugins: async () => rows,
      claimChannelPluginLease: async () => { claims++; return true; },
      updateChannelPluginStatus: async () => {},
      releaseAllChannelPluginLeases: async () => {},
    } as unknown as DirectConnectStore;
    const plugins = new PluginManager({ reload: async () => { reloads++; } } as SessionManager, db, null, 'instance');
    const first = plugins.startEnabledPlugins();
    await nextTurn();
    const overlapping = plugins.startEnabledPlugins();
    await nextTurn();
    expect(ControlledPlugin.instances).toHaveLength(2);
    expect(claims).toBe(2);
    gate.resolve();
    await Promise.all([first, overlapping]);
    expect(reloads).toBe(1);
    await plugins.stopAll();
  });

  it('does not install a lease timer after shutdown races with the initial HA pass', async () => {
    manager();
    const gate = deferred();
    ControlledPlugin.nextStart = gate.promise;
    let releases = 0;
    const db = {
      listChannelPlugins: async () => [{
        id: 'test', type: 'test-lifecycle', name: 'test', enabled: 1, status: 'stopped',
        user_id: 'user', created_at: 1, updated_at: 1,
      }],
      claimChannelPluginLease: async () => true,
      updateChannelPluginStatus: async () => {},
      releaseAllChannelPluginLeases: async () => { releases++; },
    } as unknown as DirectConnectStore;
    const plugins = new PluginManager({ reload: async () => {} } as SessionManager, db, null, 'instance');
    const timer = spyOn(globalThis, 'setInterval');
    try {
      const start = plugins.startEnabledPlugins();
      await nextTurn();
      const shutdown = plugins.stopAll();
      gate.resolve();
      await Promise.all([start, shutdown]);
      expect(plugins.getAllPlugins()).toHaveLength(0);
      expect(releases).toBe(1);
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
      await plugins.stopAll();
    }
  });

  it('isolates malformed stored configuration while another leased bot starts', async () => {
    manager();
    const rows = ['bad', 'good'].map((id) => ({
      id, type: 'test-lifecycle', name: id, enabled: 1, status: 'stopped',
      user_id: 'user', created_at: 1, updated_at: 1,
      config_json: id === 'bad' ? '{' : '{}',
    }));
    const db = {
      listChannelPlugins: async () => rows,
      claimChannelPluginLease: async () => true,
      updateChannelPluginStatus: async () => {},
      releaseAllChannelPluginLeases: async () => {},
    } as unknown as DirectConnectStore;
    const plugins = new PluginManager({ reload: async () => {} } as SessionManager, db, null, 'instance');
    await plugins.startEnabledPlugins();
    expect(plugins.getPlugin('bad:user')).toBeUndefined();
    expect(plugins.getPlugin('good:user')?.status).toBe('running');
    await plugins.stopAll();
  });
});
