import { expect, it, mock } from 'bun:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

const sdk = await import('@larksuiteoapi/node-sdk');
const RealWsClient = sdk.WSClient;
type WsOptions = ConstructorParameters<typeof RealWsClient>[0];
const clients: InstanceType<typeof RealWsClient>[] = [];
let endpoint = '';
let allowDiscovery!: () => void;
let discoveryCalls = 0;
const discovery = new Promise<void>((resolve) => { allowDiscovery = resolve; });

class LocalWsClient extends RealWsClient {
  constructor(options: WsOptions) {
    super({
      ...options,
      // Only discovery is substituted. The installed SDK owns the real socket,
      // readiness callbacks, retry generation and close/timer cleanup.
      httpInstance: {
        async request() {
          discoveryCalls++;
          await discovery;
          return {
            code: 0,
            data: {
              URL: endpoint,
              ClientConfig: { PingInterval: 60, ReconnectCount: 1, ReconnectInterval: 0, ReconnectNonce: 0 },
            },
          };
        },
      } as unknown as NonNullable<WsOptions['httpInstance']>,
    });
    clients.push(this);
  }
}

mock.module('@larksuiteoapi/node-sdk', () => ({ ...sdk, WSClient: LocalWsClient }));
const { LarkPlugin } = await import('../plugins/lark/LarkPlugin.js');

it('waits for a real SDK socket and prevents reconnect after disabling the plugin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moss-lark-socket-'));
  const originalCwd = process.cwd();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const plugin = new LarkPlugin();
  try {
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    endpoint = `ws://127.0.0.1:${address.port}/?device_id=local&service_id=1`;
    process.chdir(directory);
    await plugin.initialize({
      id: 'lark_local', type: 'lark', name: 'local test', enabled: true,
      status: 'stopped', createdAt: 1, updatedAt: 1,
      credentials: { appId: 'cli_0123456789abcdef', appSecret: 'local-only-secret' },
    });
    const start = plugin.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(plugin.status).toBe('starting');
    expect(plugin.isConnectionReady).toBe(false);
    expect(discoveryCalls).toBe(1);
    const socketConnected = once(server, 'connection');
    allowDiscovery();
    await start;
    const [socket] = await socketConnected;
    expect(plugin.status).toBe('running');
    expect(plugin.isConnectionReady).toBe(true);
    const socketClosed = once(socket, 'close');
    await plugin.stop();
    await socketClosed;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(plugin.status).toBe('stopped');
    expect(plugin.isConnectionReady).toBe(false);
    expect(clients[0].getConnectionStatus().state).toBe('idle');
    expect(discoveryCalls).toBe(1);
    expect(server.clients.size).toBe(0);
  } finally {
    allowDiscovery();
    await plugin.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
  }
});
