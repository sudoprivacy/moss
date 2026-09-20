// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { DirectConnectStore } from '../db.js'

describe('legacy session runtime schema migration', () => {
  it('upgrades legacy session tables without losing existing rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'moss-legacy-runtime-schema-'))
    const dbPath = join(dir, 'moss.db')

    try {
      const legacy = new DatabaseSync(dbPath)
      legacy.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          transcript_session_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          cwd TEXT NOT NULL,
          docker_image TEXT,
          profile_dir TEXT NOT NULL,
          workspace_dir TEXT,
          transcript_dir TEXT NOT NULL,
          container_name TEXT,
          status TEXT NOT NULL,
          desired_state TEXT NOT NULL,
          current_attempt_id TEXT,
          transcript_path TEXT NOT NULL,
          title TEXT,
          summary TEXT,
          assistant_name TEXT,
          advanced_settings_json TEXT NOT NULL DEFAULT '{}',
          auto_memory_json TEXT NOT NULL DEFAULT '{}',
          session_memory_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL,
          ended_at INTEGER,
          deleted_at INTEGER
        );
        CREATE TABLE session_attempts (
          attempt_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          generation INTEGER NOT NULL,
          runtime_state TEXT NOT NULL,
          server_instance_id TEXT,
          runner_pid INTEGER,
          container_name TEXT,
          attempt_dir TEXT NOT NULL,
          manifest_path TEXT NOT NULL,
          attach_path TEXT,
          resume_transcript_session_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          last_heartbeat_at INTEGER,
          stopped_at INTEGER,
          exit_code INTEGER,
          exit_signal TEXT,
          stop_reason TEXT,
          error_text TEXT,
          UNIQUE (session_id, generation)
        );
      `)
      legacy.prepare(`
        INSERT INTO sessions (
          session_id, transcript_session_id, org_id, user_id, role, scopes_json,
          cwd, docker_image, profile_dir, workspace_dir, transcript_dir,
          container_name, status, desired_state, transcript_path, created_at,
          last_active_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'legacy-session', 'legacy-transcript', 'org-1', 'user-1', 'user', '[]',
        '/tmp/workspace', 'runtime:legacy', '/tmp/config', '/tmp/workspace',
        '/tmp/transcripts', 'legacy-container', 'active', 'active',
        '/tmp/transcripts/legacy.jsonl', 1, 1,
      )
      legacy.prepare(`
        INSERT INTO session_attempts (
          attempt_id, session_id, generation, runtime_state, attempt_dir,
          manifest_path, resume_transcript_session_id, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'legacy-attempt', 'legacy-session', 1, 'running', '/tmp/attempt',
        '/tmp/attempt/manifest.json', 'legacy-transcript', 1,
      )
      legacy.close()

      const store = new DirectConnectStore(dbPath)
      const migrated = await store.getSession('legacy-session')
      const attempt = await store.getAttempt('legacy-attempt')

      assert.equal(migrated?.runtime.type, 'docker')
      assert.equal(migrated?.runtime.dockerMode, 'session')
      assert.equal(migrated?.runtime.configDir, '/tmp/config')
      assert.equal(attempt?.backendType, 'docker')

      await store.createSession({
        sessionId: 'new-session',
        transcriptSessionId: 'new-transcript',
        transcriptPath: '/tmp/transcripts/new.jsonl',
        userId: 'user-2',
        orgId: 'org-1',
        role: 'user',
        scopes: [],
        cwd: '/tmp/workspace',
        runtime: { type: 'host', engine: 'scode' },
        status: 'creating',
        desiredState: 'active',
      })
      await store.createAttempt({
        sessionId: 'new-session',
        generation: 1,
        backendType: 'host',
        resumeTranscriptSessionId: 'new-transcript',
        serverInstanceId: 'server-1',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
