import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import {
  getTranscriptPath,
  getSessionTranscriptDir,
  getSessionScodeHomeDir,
  getInContainerPidFile,
} from '../runtimePaths.js'

describe('transcript path migration (A3)', () => {
  it('lives under runtimeDir/sessions/<sid>/transcript, independent of cwd / configDir', () => {
    const tp = getTranscriptPath('/runtime', 'sid-abc', 'tsid-xyz')
    expect(tp).toBe('/runtime/sessions/sid-abc/transcript/tsid-xyz.jsonl')
  })

  it('directory is reachable for cleanup APIs without coupling to configDir', () => {
    expect(getSessionTranscriptDir('/runtime', 'sid')).toBe(
      '/runtime/sessions/sid/transcript',
    )
    expect(getSessionScodeHomeDir('/runtime', 'sid')).toBe(
      '/runtime/sessions/sid/scode-home/.nexus/sudocode',
    )
    expect(getInContainerPidFile('/runtime', 'sid')).toBe(
      '/runtime/sessions/sid/runtime/scode.pid',
    )
  })

  it('survives a destroy that wipes configDir and scode-home', async () => {
    const runtime = await mkdtemp(path.join(tmpdir(), 'moss-tx-survive-'))
    try {
      const sid = 'sid-1'
      // Simulate session layout. transcript / configDir / scode-home / runtime
      // all exist; destroy clears the latter three but transcript persists.
      const transcriptDir = getSessionTranscriptDir(runtime, sid)
      const configDir = path.join(runtime, 'sessions', sid, 'config')
      const scodeHome = getSessionScodeHomeDir(runtime, sid)
      await mkdir(transcriptDir, { recursive: true })
      await mkdir(configDir, { recursive: true })
      await mkdir(scodeHome, { recursive: true })

      const txPath = getTranscriptPath(runtime, sid, 'tsid')
      await writeFile(txPath, JSON.stringify({ type: 'user', text: 'hi' }) + '\n')
      await writeFile(path.join(configDir, 'AGENTS.md'), 'override')
      await writeFile(path.join(scodeHome, 'sudocode.json'), '{}')

      // Simulate cleanup: rm -rf configDir + scode-home (mode === 'session' or
      // user-container cleanup).
      await rm(configDir, { recursive: true, force: true })
      await rm(scodeHome, { recursive: true, force: true })

      // Transcript still readable.
      await access(txPath)
      const content = await readFile(txPath, 'utf8')
      expect(content).toContain('hi')
    } finally {
      await rm(runtime, { recursive: true, force: true })
    }
  })
})
