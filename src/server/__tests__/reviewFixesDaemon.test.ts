// Bun only (same constraint as runtimeServiceFencing.test.ts): the
// sessionRunnerDaemon / PluginManager import chains carry bun:-protocol
// transitive deps that Node's loader rejects (ERR_UNSUPPORTED_ESM_URL_SCHEME).
// Covers the 2026-09-15 daemon-side fixes:
//   A4  mayStampDaemonLifecycle guard (daemon must not revive a terminated
//       session whose status was raced to 'failed'/'lost')
//   A5  stopPluginLocally removes the map entry even when plugin.stop() throws
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mayStampDaemonLifecycle, SessionRunnerDaemon } from "../sessionRunnerDaemon.js";
import { PluginManager } from "../../channels/gateway/PluginManager.js";
import { spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RuntimeBackend } from '../backends/runtimeBackend.js';
import type { RunnerManifest } from '../types.js';
import type { BackendHandle } from '../sessionManager.js';
import type { DirectConnectStore } from '../db.js';
import { readLiveManagedExecution } from '../backends/liveManagedExecution.js';
import type { InternalSessionChannel } from '../internalSessionChannel.js';
import { cohostSessionStatePath } from '../backends/cohostSessionState.js';

describe('Runner cancellation during recovery', () => {
  for (const isTermination of [false, true]) {
    it(`cancels a pending spawn and preserves ${isTermination ? 'termination' : 'restart'} intent`, { timeout: 30_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'moss-runner-start-stop-'));
      const attachPath = process.platform === 'win32' ? `\\\\.\\pipe\\moss-runner-start-stop-${randomUUID()}` : join(root, 'runner.sock');
      const listeners = process.listeners('SIGTERM');
      let lifecycle: unknown;
      let reason: string | undefined;
      const events: string[] = [];
      const store = {
        cohostSessions: { get: async () => undefined },
        updateAttemptRunner: async () => {}, touchAttemptHeartbeat: async () => true,
        isOpen: () => true,
        addEvent: async (_session: string, _attempt: string, event: string) => { events.push(event); },
        getSession: async () => ({ status: 'starting', desiredState: 'active' }),
        setSessionLifecycle: async () => {},
        markAttemptStopped: async (_id: string, value: { stopReason: string }) => { reason = value.stopReason; return true; },
        markSessionEnded: async (_id: string, status: string, desiredState: string) => { lifecycle = { status, desiredState }; },
        close: async () => {},
      };
      const manifest = {
        config: { heartbeatTimeoutMs: 30_000, idleTimeoutMs: 0 },
        session: { sessionId: 'test-session', userId: 'owner', orgId: 'org', runtime: { type: 'cohost' }, cwd: root },
        attempt: { attemptId: 'attempt', runtimeDir: root, attachPath, statusPath: join(root, 'status.json'), stderrLogPath: join(root, 'stderr.log') },
      } as RunnerManifest;
      let onSpawn!: () => void;
      const spawned = new Promise<void>(resolve => { onSpawn = resolve; });
      const spawn = spyOn(RuntimeBackend.prototype, 'spawn').mockImplementation(options => new Promise((_resolve, reject) => {
        assert.ok(options.signal);
        options.signal.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
        onSpawn();
      }));
      const daemon = new SessionRunnerDaemon(manifest, store as unknown as DirectConnectStore);
      let socket: ReturnType<typeof createConnection> | undefined;
      let kill: ReturnType<typeof spyOn> | undefined;
      try {
        const started = daemon.start();
        const rejected = assert.rejects(started, /runner is stopping/);
        await spawned;
        const onSignal = process.listeners('SIGTERM').find(listener => !listeners.includes(listener));
        assert.ok(onSignal);
        if (isTermination) {
          kill = spyOn(process, 'kill').mockImplementation(() => { onSignal('SIGTERM'); return true; });
          socket = createConnection(attachPath);
          await new Promise<void>((resolve, reject) => { socket!.once('connect', resolve); socket!.once('error', reject); });
          socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
        } else onSignal('SIGTERM');
        await rejected;
        assert.equal(reason, isTermination ? 'terminated' : 'process_shutdown');
        assert.deepEqual(lifecycle, isTermination ? { status: 'terminated', desiredState: 'terminated' } : { status: 'ended', desiredState: 'active' });
        assert.ok(!events.includes('attempt_started'));
        assert.equal(JSON.parse(await readFile(manifest.attempt.statusPath, 'utf8')).state, 'stopped');
        assert.deepEqual(process.listeners('SIGTERM'), listeners);
      } finally {
        socket?.destroy(); kill?.mockRestore(); spawn.mockRestore();
        await daemon.shutdown();
        assert.ok(root.startsWith(join(tmpdir(), 'moss-runner-start-stop-')));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe('Cohost runner execution identity', () => {
  it('publishes the live process to early and late attachments without persisting it', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-runner-identity-'));
    const attachPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\moss-runner-identity-${randomUUID()}`
      : join(root, 'runner.sock');
    const originalListeners = new Map((['SIGTERM', 'SIGINT'] as const).map(signal => [signal, process.listeners(signal)]));
    const events: unknown[] = [];
    const binding = { ownerId: 'test-user', agentId: 'test', durableSessionId: 'native-durable', repositoryPath: '/agents/test/workspaces/test-session' };
    await mkdir(join(root, '.moss'));
    await writeFile(cohostSessionStatePath(root), JSON.stringify({ ...binding, sessionId: 'obsolete-pid' }));
    let onBound!: () => void;
    let releaseBinding!: () => void;
    const bound = new Promise<void>(resolve => { onBound = resolve; });
    const bindingCommit = new Promise<void>(resolve => { releaseBinding = resolve; });
    const store = {
      cohostSessions: { get: async () => binding,
      bind: async (_sid: string, _aid: string, candidate: unknown, owner: string) => {
        assert.deepEqual(candidate, binding);
        assert.equal(owner, 'test-owner');
        onBound();
        await bindingCommit;
        return true;
      } },
      updateAttemptRunner: async () => {}, touchAttemptHeartbeat: async () => true,
      addEvent: async (...args: unknown[]) => { events.push(args); },
      isOpen: () => true, getSession: async () => ({ status: 'active', desiredState: 'active' }),
      setSessionLifecycle: async () => {}, markAttemptStopped: async () => true,
      markSessionEnded: async () => {}, close: async () => {},
    };
    const manifest = {
      config: { heartbeatTimeoutMs: 30_000, idleTimeoutMs: 0, instanceId: 'obsolete-config-owner' },
      session: { sessionId: 'test-session', userId: 'test-user', orgId: 'test-org', runtime: { type: 'cohost' }, cwd: root },
      attempt: { attemptId: 'test-attempt', serverInstanceId: 'test-owner', runtimeDir: root, attachPath, statusPath: join(root, 'status.json') },
    } as RunnerManifest;
    let onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
    const handle = {
      runtime: manifest.session.runtime, managedProcessId: 'native-live-process', cohostSessionBinding: binding,
      onStdoutLine: () => {}, onStderrLine: () => {},
      onExit: (callback: typeof onExit) => { onExit = callback; },
      destroy: () => { onExit(0, 'SIGTERM'); },
    } as unknown as BackendHandle;
    let releaseSpawn!: (handle: BackendHandle) => void;
    let onSpawn!: () => void;
    const spawned = new Promise<void>(resolve => { onSpawn = resolve; });
    const spawn = spyOn(RuntimeBackend.prototype, 'spawn').mockImplementation(options => {
      assert.deepEqual(options.cohostSessionBinding, binding);
      onSpawn();
      return new Promise(resolve => { releaseSpawn = resolve; });
    });
    const daemon = new SessionRunnerDaemon(manifest, store as unknown as DirectConnectStore);
    const sockets: ReturnType<typeof createConnection>[] = [];
    try {
      const started = daemon.start();
      await spawned;
      const early = createConnection(attachPath);
      sockets.push(early);
      let isReady = false;
      const processReady = readLiveManagedExecution(early as unknown as InternalSessionChannel, 'test-session')
        .then(execution => { isReady = true; return execution; });
      const starting = await new Promise<Record<string, unknown>>((resolve, reject) => {
        early.once('data', bytes => resolve(JSON.parse(bytes.toString().trim())));
        early.once('error', reject);
      });
      assert.equal(starting.state, 'starting');
      assert.equal(starting.managedProcessId, undefined);
      releaseSpawn(handle);
      await bound;
      assert.equal(isReady, false, 'runner must not advertise an execution before its durable binding commits');
      assert.ok(await readFile(cohostSessionStatePath(root), 'utf8'), 'legacy recovery data survives until the shared commit');
      releaseBinding();
      assert.deepEqual(await processReady, { processId: 'native-live-process', binding });
      await started;
      await assert.rejects(readFile(cohostSessionStatePath(root), 'utf8'), { code: 'ENOENT' });
      const late = createConnection(attachPath);
      sockets.push(late);
      assert.deepEqual(await readLiveManagedExecution(late as unknown as InternalSessionChannel, 'test-session'),
        { processId: 'native-live-process', binding });
      assert.ok(!(await readFile(manifest.attempt.statusPath, 'utf8')).includes('native-live-process'));
      assert.ok(!JSON.stringify(events).includes('native-live-process'));
    } finally {
      releaseSpawn(handle);
      releaseBinding();
      for (const socket of sockets) socket.destroy();
      await daemon.shutdown();
      spawn.mockRestore();
      for (const [signal, original] of originalListeners) {
        for (const listener of process.listeners(signal)) {
          if (!original.includes(listener)) process.removeListener(signal, listener);
        }
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        try { if (JSON.parse(await readFile(manifest.attempt.statusPath, 'utf8')).state === 'stopped') break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(root.startsWith(join(tmpdir(), 'moss-runner-identity-')));
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Cohost binding publication failures', () => {
  for (const failure of ['fenced', 'store', 'cleanup'] as const) {
    it(`cleans up a started execution after ${failure} failure before publishing readiness`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'moss-runner-binding-failure-'));
      const attachPath = process.platform === 'win32' ? `\\\\.\\pipe\\moss-binding-${randomUUID()}` : join(root, 'runner.sock');
      const storeError = new Error('binding store unavailable');
      const cleanupError = new Error('execution cancellation denied');
      const events: string[] = [];
      let destroys = 0;
      const store = {
        cohostSessions: { get: async () => undefined, bind: async () => {
          if (failure !== 'fenced') throw storeError;
          return false;
        } },
        updateAttemptRunner: async () => {}, touchAttemptHeartbeat: async () => true, isOpen: () => true,
        addEvent: async (_sid: string, _aid: string, event: string) => { events.push(event); },
        markAttemptStopped: async () => true, markSessionEnded: async () => {}, close: async () => {},
      };
      const manifest = {
        config: { heartbeatTimeoutMs: 30_000, idleTimeoutMs: 0, instanceId: 'host-a' },
        session: { sessionId: 'moss-session', userId: 'owner', orgId: 'org', runtime: { type: 'cohost' }, cwd: root },
        attempt: { attemptId: 'attempt', attachPath, runtimeDir: root, statusPath: join(root, 'status.json'),
          stderrLogPath: join(root, 'stderr.log') },
      } as RunnerManifest;
      const spawn = spyOn(RuntimeBackend.prototype, 'spawn').mockResolvedValue({
        runtime: manifest.session.runtime, cohostSessionBinding: { ownerId: 'owner', agentId: 'owner', durableSessionId: 'native', repositoryPath: '/agents/owner/workspaces/moss-session' },
        destroy: async () => { destroys++; if (failure === 'cleanup') throw cleanupError; },
      } as unknown as BackendHandle);
      const daemon = new SessionRunnerDaemon(manifest, store as unknown as DirectConnectStore);
      try {
        await assert.rejects(daemon.start(), error => failure === 'fenced' ? /lost ownership/.test(String(error)) :
          failure === 'store' ? error === storeError : error instanceof AggregateError &&
            error.errors[0] === storeError && error.errors[1] === cleanupError);
        assert.equal(destroys, 1);
        assert.ok(!events.includes('attempt_started'));
        assert.equal(JSON.parse(await readFile(manifest.attempt.statusPath, 'utf8')).state, 'failed');
      } finally { spawn.mockRestore(); await daemon.shutdown(); await rm(root, { recursive: true, force: true }); }
    });
  }
});

describe('Runner shutdown preserves conversation intent', () => {
  for (const scenario of ['SIGTERM', 'SIGINT', 'protocol', 'deleted', 'fenced'] as const) {
    it(`handles ${scenario} through the registered signal and backend exit callbacks`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'moss-runner-stop-'));
      const attachPath = process.platform === 'win32'
        ? `\\\\.\\pipe\\moss-runner-stop-${randomUUID()}`
        : join(root, 'runner.sock');
      const listeners = new Map((['SIGTERM', 'SIGINT'] as const).map(signal => [signal, process.listeners(signal)]));
      let onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
      let onClosed!: () => void;
      const closed = new Promise<void>(resolve => { onClosed = resolve; });
      let lifecycle = { status: 'active', desiredState: 'active' };
      let stopReason: string | undefined;
      const store = {
        updateAttemptRunner: async () => {},
        touchAttemptHeartbeat: async () => true,
        addEvent: async () => {},
        isOpen: () => true,
        getSession: async () => lifecycle,
        setSessionLifecycle: async (_id: string, status: string, desiredState: string) => {
          lifecycle = { status, desiredState };
        },
        markAttemptStopped: async (_id: string, update: { stopReason: string }) => {
          stopReason = update.stopReason;
          return scenario !== 'fenced';
        },
        markSessionEnded: async (_id: string, status: string, desiredState: string) => {
          // The real store's atomic deletion guard has separate SQLite tests.
          if (lifecycle.desiredState !== 'terminated') lifecycle = { status, desiredState };
        },
        close: async () => { onClosed(); },
      };
      const manifest = {
        config: { heartbeatTimeoutMs: 30_000, idleTimeoutMs: 0, instanceId: 'test-owner' },
        session: { sessionId: 'test-session', userId: 'test-user', orgId: 'test-org', runtime: { type: 'host' }, cwd: root },
        attempt: { attemptId: 'test-attempt', runtimeDir: root, attachPath, statusPath: join(root, 'status.json') },
      } as RunnerManifest;
      const handle = {
        runtime: manifest.session.runtime,
        onStdoutLine: () => {},
        onStderrLine: () => {},
        onExit: (callback: typeof onExit) => { onExit = callback; },
        destroy: () => { onExit(0, 'SIGTERM'); },
      } as unknown as BackendHandle;
      const spawn = spyOn(RuntimeBackend.prototype, 'spawn').mockResolvedValue(handle);
      const daemon = new SessionRunnerDaemon(manifest, store as unknown as DirectConnectStore);
      let socket: ReturnType<typeof createConnection> | undefined;
      let kill: ReturnType<typeof spyOn> | undefined;
      try {
        await daemon.start();
        await new Promise(resolve => setImmediate(resolve));
        const initialLifecycle = { ...lifecycle };
        const signal = scenario === 'SIGINT' ? 'SIGINT' : 'SIGTERM';
        const onSignal = process.listeners(signal).find(listener => !listeners.get(signal)!.includes(listener));
        assert.ok(onSignal);
        if (scenario === 'deleted') lifecycle = { status: 'terminated', desiredState: 'terminated' };
        if (scenario === 'protocol') {
          // Deliver the real runner protocol over its socket, intercepting only
          // the OS kill so this test cannot terminate the test runner itself.
          kill = spyOn(process, 'kill').mockImplementation(() => { onSignal(signal); return true; });
          socket = createConnection(attachPath);
          await new Promise<void>((resolve, reject) => {
            socket!.once('connect', resolve);
            socket!.once('error', reject);
          });
          socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
        } else {
          onSignal(signal);
        }
        await Promise.race([closed, new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Runner did not close')), 3000);
          timer.unref();
        })]);
        // The daemon writes its final status asynchronously after closing.
        // Wait for that write before removing the test's temporary directory.
        for (let attempt = 0; ; attempt++) {
          try {
            const status = JSON.parse(await readFile(manifest.attempt.statusPath, 'utf8'));
            if (status.state === 'stopped') break;
          } catch {}
          assert.ok(attempt < 100, 'Final runner status must be persisted');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(stopReason, scenario === 'protocol' ? 'terminated' : 'process_shutdown');
        assert.deepEqual(lifecycle, scenario === 'protocol' || scenario === 'deleted'
          ? { status: 'terminated', desiredState: 'terminated' }
          : scenario === 'fenced'
            ? initialLifecycle
            : { status: 'ended', desiredState: 'active' });
      } finally {
        socket?.destroy();
        kill?.mockRestore();
        spawn.mockRestore();
        for (const [signal, original] of listeners) {
          for (const listener of process.listeners(signal)) {
            if (!original.includes(listener)) process.removeListener(signal, listener);
          }
        }
        await daemon.shutdown();
        assert.ok(root.startsWith(join(tmpdir(), 'moss-runner-stop-')));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe("A4: mayStampDaemonLifecycle", () => {
  it("allows stamping a live active session", () => {
    assert.equal(mayStampDaemonLifecycle({ status: "active", desiredState: "active" }), true);
  });

  it("blocks terminal statuses", () => {
    assert.equal(mayStampDaemonLifecycle({ status: "terminated", desiredState: "active" }), false);
    assert.equal(mayStampDaemonLifecycle({ status: "ended", desiredState: "active" }), false);
  });

  it("blocks a user-terminated session whose status was raced to failed/lost (the A4 window)", () => {
    assert.equal(mayStampDaemonLifecycle({ status: "failed", desiredState: "terminated" }), false);
    assert.equal(mayStampDaemonLifecycle({ status: "lost", desiredState: "terminated" }), false);
  });

  it("still allows the daemon #fail chain's own (failed, active) write-back target", () => {
    assert.equal(mayStampDaemonLifecycle({ status: "failed", desiredState: "active" }), true);
  });

  it("handles null session lookups", () => {
    assert.equal(mayStampDaemonLifecycle(null), false);
  });
});

describe("A5: stopPluginLocally always removes the map entry", () => {
  it("deletes the entry when plugin.stop() throws instead of retrying forever", async () => {
    const pm = new PluginManager({} as never, {} as never, null, "test-instance");
    const failing = { stop: async () => { throw new Error("bot wedged") } };
    const plugins = (pm as unknown as { plugins: Map<string, { stop(): Promise<void> }> }).plugins;
    plugins.set("tg:u1", failing);
    await (pm as unknown as { stopPluginLocally(k: string): Promise<void> }).stopPluginLocally("tg:u1");
    assert.equal(plugins.has("tg:u1"), false, "entry must be removed even when stop() fails");
  });

  it("deletes the entry on the success path too", async () => {
    const pm = new PluginManager({} as never, {} as never, null, "test-instance");
    const plugins = (pm as unknown as { plugins: Map<string, { stop(): Promise<void> }> }).plugins;
    plugins.set("tg:u2", { stop: async () => {} });
    await (pm as unknown as { stopPluginLocally(k: string): Promise<void> }).stopPluginLocally("tg:u2");
    assert.equal(plugins.has("tg:u2"), false);
  });
});
