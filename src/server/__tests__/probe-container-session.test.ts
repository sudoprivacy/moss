import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile, chmod, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import { probeContainerSession } from '../runtime/probeContainerSession.js'

/**
 * Replace `docker` on PATH with a script that simulates `docker exec ... sh -c
 * <probe-script>` by running the probe script against a controlled fake
 * environment. The probe script uses /proc/<pid>/stat which on macOS doesn't
 * exist, but we coerce the docker shim to emit canned ALIVE/STALE/DEAD/MISSING
 * markers directly.
 */
async function setupFakeDocker(emit: string): Promise<{
  dir: string
  cleanup: () => Promise<void>
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'moss-fake-docker-probe-'))
  const script = `#!/bin/sh
# We are emulating: docker exec <container> sh -c <probe-script>
# Real exec/sh would evaluate the probe; for tests we emit the canned outcome.
case "$1" in
  exec)
    printf '%s\\n' "${emit}"
    ;;
esac
exit 0
`
  const docker = path.join(dir, 'docker')
  await writeFile(docker, script)
  await chmod(docker, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`
  return {
    dir,
    cleanup: async () => {
      process.env.PATH = previousPath
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('probeContainerSession', () => {
  let cleanup: () => Promise<void>

  afterEach(async () => {
    if (cleanup) await cleanup()
  })

  it('returns alive when shim emits ALIVE pid ticks', async () => {
    const fake = await setupFakeDocker('ALIVE 1234 5678')
    cleanup = fake.cleanup
    const r = await probeContainerSession({
      userContainerName: 'moss-user-fake',
      sessionId: 'sid',
    })
    expect(r.kind).toBe('alive')
    expect(r.pid).toBe(1234)
  })

  it('returns stale_pid_reuse when shim emits STALE pid recTicks curTicks', async () => {
    const fake = await setupFakeDocker('STALE 4567 11111 22222')
    cleanup = fake.cleanup
    const r = await probeContainerSession({
      userContainerName: 'moss-user-fake',
      sessionId: 'sid',
    })
    expect(r.kind).toBe('stale_pid_reuse')
    expect(r.pid).toBe(4567)
    expect(r.recordedStartTicks).toBe('11111')
    expect(r.currentStartTicks).toBe('22222')
  })

  it('returns dead when shim emits DEAD', async () => {
    const fake = await setupFakeDocker('DEAD 999')
    cleanup = fake.cleanup
    const r = await probeContainerSession({
      userContainerName: 'moss-user-fake',
      sessionId: 'sid',
    })
    expect(r.kind).toBe('dead')
  })

  it('returns missing on empty output', async () => {
    const fake = await setupFakeDocker('MISSING')
    cleanup = fake.cleanup
    const r = await probeContainerSession({
      userContainerName: 'moss-user-fake',
      sessionId: 'sid',
    })
    expect(r.kind).toBe('missing')
  })
})
