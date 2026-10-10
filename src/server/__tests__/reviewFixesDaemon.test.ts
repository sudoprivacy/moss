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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RuntimeBackend } from '../backends/runtimeBackend.js';
import type { RunnerManifest } from '../types.js';
import type { BackendHandle } from '../sessionManager.js';
import type { DirectConnectStore } from '../db.js';

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
