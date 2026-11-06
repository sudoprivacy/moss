// Runs under Node: `tsx --test`. Covers the internal session channel helper
// (P2-5): line protocol over a real local WS server, 401/403/404 fast-fail
// (no retry), and retry behaviour for 5xx / 409 / network (first retry wins).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from "ws";
import {
  openInternalSessionChannel,
  type InternalSessionChannel,
  type ChannelDeps,
} from "../internalSessionChannel.js";
import type { DirectConnectStore } from "../db.js";
import type { AuthService } from "../auth/service.js";
import type { ServerConfig } from "../types.js";
import { readLiveManagedExecution } from '../backends/liveManagedExecution.js';

const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

interface EchoServer {
  url: (path: string) => string
}

async function startEchoWsServer(onConnection?: (ws: WebSocket) => void): Promise<EchoServer> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", ws => {
    ws.on('message', data => {
      // Echo every line back verbatim (the internal endpoint's passthrough).
      ws.send(data.toString('utf8'));
    });
    onConnection?.(ws);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  closers.push(() => { wss.close(); http.close(); });
  return { url: (path: string) => `ws://127.0.0.1:${port}${path}` };
}

function makeDeps(port: number, tokenResult: string | null): ChannelDeps {
  const config = {
    host: '127.0.0.1',
    port,
    routeCookieName: 'moss_route',
    publicBaseUrl: `http://127.0.0.1:${port}`,
  } as unknown as ServerConfig;
  return {
    authService: {
      issueInternalChannelToken: () => (tokenResult ? { access_token: tokenResult } : null),
    } as unknown as AuthService,
    store: {
      getSession: (id: string) => ({ sessionId: id, userId: 'u1', orgId: 'o1', currentAttemptId: 'att1' }),
      getAttemptOwnerStatus: () => ({ ownerInstanceId: null, ownerLive: false }),
    } as unknown as DirectConnectStore,
    config,
  };
}

/** Send the authenticated protocol's upgrade and first messages in one TCP write. */
async function startCoalescedServer(messages: string[], isClosing = false): Promise<number> {
  const http = createServer();
  const sockets = new Set<import('node:stream').Duplex>();
  http.on('upgrade', (request, socket) => {
    assert.equal(request.headers.authorization, 'Bearer tok');
    assert.equal(request.url, '/ws/internal/sessions/s1');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const accept = createHash('sha1')
      .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    const frames = messages.flatMap(message => {
      const payload = Buffer.from(message);
      assert.ok(payload.length < 65_536);
      const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.alloc(4);
      if (payload.length >= 126) {
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      }
      return [header, payload];
    });
    socket.write(Buffer.concat([
      Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'), ...frames,
      ...(isClosing ? [Buffer.from([0x88, 0x02, 0x03, 0xe8])] : []),
    ]));
    if (isClosing) socket.end();
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  closers.push(() => { for (const socket of sockets) socket.destroy(); http.close(); });
  return (http.address() as { port: number }).port;
}

describe("internalSessionChannel (P2-5)", () => {
  it('reports peer closure without a data subscriber', { timeout: 3000 }, async () => {
    const port = await startCoalescedServer([], true);
    const channel = await openInternalSessionChannel(makeDeps(port, 'tok'), 's1');
    closers.push(() => channel.destroy());
    if (!channel.destroyed) await once(channel, 'close');
    assert.equal(channel.destroyed, true);
  });

  it('preserves a coalesced hello through the real workspace execution reader', { timeout: 3000 }, async () => {
    const binding = { ownerId: 'owner', agentId: 'agent', durableSessionId: 'durable', repositoryPath: '/workspace' };
    const port = await startCoalescedServer([JSON.stringify({ type: 'hello', sessionId: 's1',
      attemptId: 'attempt', runtimeType: 'cohost', state: 'running', managedProcessId: 'pid',
      cohostSessionBinding: binding })]);
    const channel = await openInternalSessionChannel(makeDeps(port, 'tok'), 's1');
    closers.push(() => channel.destroy());
    assert.deepEqual(await readLiveManagedExecution(channel, 's1'), { processId: 'pid', binding });
  });

  it('retains ordered lines while a late consumer crosses the readable buffer boundary', { timeout: 3000 }, async () => {
    const messages = Array.from({ length: 24 }, (_, index) => JSON.stringify({ index, text: '界'.repeat(2048) }));
    const port = await startCoalescedServer(messages.map((line, index) => line + (index % 2 ? '\n' : '')));
    const channel = await openInternalSessionChannel(makeDeps(port, 'tok'), 's1');
    closers.push(() => channel.destroy());
    await new Promise(resolve => setTimeout(resolve, 20));
    let buffer = '';
    const complete = new Promise<void>(resolve => {
      channel.on('data', (line: string) => {
        buffer += line;
        if (buffer.split('\n').length === messages.length + 1) resolve();
      });
    });
    await complete;
    assert.deepEqual(buffer.trimEnd().split('\n'), messages);
    channel.end();
    if (!channel.destroyed) await once(channel, 'close');
    assert.equal(channel.destroyed, true);
  });

  it("delivers line protocol both ways against a real WS endpoint", async () => {
    const server = await startEchoWsServer();
    const { url } = server;
    // Bypass openInternalSessionChannel's store lookup: exercise connectOnce
    // semantics via the exported opener with a seeded session record.
    const store = {
      getSession: (id: string) => ({
        sessionId: id,
        userId: 'u1',
        orgId: 'o1',
        currentAttemptId: 'att1',
      }),
      getAttemptOwnerStatus: () => ({ ownerInstanceId: null, ownerLive: false }),
    } as unknown as DirectConnectStore;
    const deps = {
      authService: {
        issueInternalChannelToken: () => ({ access_token: 'tok' }),
      } as unknown as AuthService,
      store,
      config: { host: '127.0.0.1', port: 0, routeCookieName: 'moss_route' },
    } as unknown as ChannelDeps;

    // Patch the URL builder through config: use publicBaseUrl pointing at the
    // echo server, no instanceId → no route query, direct connect.
    (deps.config as unknown as { publicBaseUrl: string }).publicBaseUrl =
      url('/').replace('ws://', 'ws://').replace(/\/$/, '');

    const channel: InternalSessionChannel =
      await openInternalSessionChannel(deps, 's1');

    const received: string[] = [];
    channel.on('data', (line: string) => received.push(line));
    const sent = channel.write(JSON.stringify({ type: 'ping' }));
    assert.equal(sent, true);
    await new Promise<void>(resolve => {
      const check = () => (received.length > 0 ? resolve() : setTimeout(check, 10));
      check();
    });
    assert.match(received[0]!, /"type":"ping"/);
    assert.ok(received[0]!.endsWith('\n'), "lines keep the newline contract for socket-parsers");
    channel.destroy();
  });

  it("4xx handshake fails fast without retries", async () => {
    // HTTP server that answers 401 on upgrade → 'unexpected-response'.
    const http: HttpServer = createServer((req, res) => {
      res.statusCode = 401;
      res.end('nope');
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    closers.push(() => http.close());

    const deps = makeDeps(port, 'tok');
    const startedAt = Date.now();
    await assert.rejects(
      () => openInternalSessionChannel(deps, 's1'),
      (e: unknown) => (e as Error & { status?: number }).status === 401,
    );
    // Fast-fail: no 1s+ backoff was paid.
    assert.ok(Date.now() - startedAt < 900, "401 must not enter the retry loop");
  });

  it("409 (owned by a live peer) retries instead of fast-failing", async () => {
    // First upgrade answers 409 the way the server does for owner
    // contention (bare status line, see server.ts internal handler); the
    // retry lands on a healthy echo endpoint and the channel opens.
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', ws => {
      ws.on('message', data => ws.send(data.toString('utf8')));
    });
    let upgrades = 0;
    const http: HttpServer = createServer();
    http.on('upgrade', (req, socket, head) => {
      upgrades += 1;
      if (upgrades === 1) {
        socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    closers.push(() => { wss.close(); http.close(); });

    const deps = makeDeps(port, 'tok');
    const channel: InternalSessionChannel = await openInternalSessionChannel(deps, 's1');
    assert.ok(upgrades >= 2, 'the 409 must have been retried, not aborted');

    const received: string[] = [];
    channel.on('data', (line: string) => received.push(line));
    channel.write(JSON.stringify({ type: 'ping' }));
    await new Promise<void>(resolve => {
      const check = () => (received.length > 0 ? resolve() : setTimeout(check, 10));
      check();
    });
    assert.match(received[0]!, /"type":"ping"/);
    channel.destroy();
  });

  it("write on a closed channel returns false, invokes onError and emits 'error'", async () => {
    const server = await startEchoWsServer();
    const { url } = server;
    const store = {
      getSession: (id: string) => ({
        sessionId: id,
        userId: 'u1',
        orgId: 'o1',
        currentAttemptId: 'att1',
      }),
      getAttemptOwnerStatus: () => ({ ownerInstanceId: null, ownerLive: false }),
    } as unknown as DirectConnectStore;
    const deps = {
      authService: {
        issueInternalChannelToken: () => ({ access_token: 'tok' }),
      } as unknown as AuthService,
      store,
      config: { host: '127.0.0.1', port: 0, routeCookieName: 'moss_route' },
    } as unknown as ChannelDeps;
    (deps.config as unknown as { publicBaseUrl: string }).publicBaseUrl =
      url('/').replace(/\/$/, '');

    const channel: InternalSessionChannel = await openInternalSessionChannel(deps, 's1');
    // Close the underlying ws so the next write observes a non-OPEN state.
    channel.destroy();

    const errorsSeen: unknown[] = [];
    channel.on('error', (e: unknown) => errorsSeen.push(e));
    let onErrorArg: unknown;
    const ok = channel.write(JSON.stringify({ type: 'ping' }), (e: unknown) => {
      onErrorArg = e;
    });

    assert.equal(ok, false, "write on a closed channel must report failure");
    assert.ok(onErrorArg instanceof Error, "onError callback receives an Error");
    assert.equal(errorsSeen.length, 1, "a live 'error' listener receives exactly one emit");
    assert.ok(errorsSeen[0] instanceof Error);
  });
});
