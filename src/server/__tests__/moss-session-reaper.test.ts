import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { tmpdir, platform } from 'os'
import path from 'path'

const LAUNCH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'deploy',
  'runtime',
  'moss-session-launch.sh',
)
const REAP = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'deploy',
  'runtime',
  'moss-session-reap.sh',
)

function run(
  cmd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    c.stdout?.on('data', d => { stdout += d.toString('utf8') })
    c.stderr?.on('data', d => { stderr += d.toString('utf8') })
    c.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

const linuxOnly = platform() === 'linux'

describe('moss-session reaper script', () => {
  if (!linuxOnly) {
    it.skip('skipped on non-linux: /proc/<pid>/stat unavailable', () => {})
    return
  }

  it('rejects launch without "--" separator', async () => {
    const result = await run('/bin/sh', [LAUNCH, 'sid'], { MOSS_RUNTIME_DIR: '/tmp' })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('usage')
  })

  it('PID reuse: reaper skips kill when start_ticks does not match', async () => {
    const rt = await mkdtemp(path.join(tmpdir(), 'moss-reap-pidreuse-'))
    const sid = 'session-reuse'
    const meta = path.join(rt, 'sessions', sid, 'runtime')
    await spawnAndWaitMkdir(meta)

    // Write a synthetic pidfile pointing at PID 1 (init, always alive) with a
    // tweaked start_ticks that intentionally won't match init's real value.
    await writeFile(path.join(meta, 'scode.pid'), '1\n')
    await writeFile(path.join(meta, 'scode.start_ticks'), '999999999\n')
    await writeFile(path.join(meta, 'scode.session_id'), `${sid}\n`)

    const out = await run('/bin/sh', [REAP, sid, '500'], { MOSS_RUNTIME_DIR: rt })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('start_ticks mismatch')

    // Metadata cleared.
    expect(existsSync(path.join(meta, 'scode.pid'))).toBe(false)
    expect(existsSync(path.join(meta, 'scode.start_ticks'))).toBe(false)

    await rm(rt, { recursive: true, force: true })
  })

  it('no-op if pidfile does not exist', async () => {
    const rt = await mkdtemp(path.join(tmpdir(), 'moss-reap-nopid-'))
    const out = await run('/bin/sh', [REAP, 'unknown', '500'], { MOSS_RUNTIME_DIR: rt })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('no pidfile')
    await rm(rt, { recursive: true, force: true })
  })

  it('dead-pid path: pidfile present but pid gone -> clears metadata', async () => {
    const rt = await mkdtemp(path.join(tmpdir(), 'moss-reap-deadpid-'))
    const sid = 'session-dead'
    const meta = path.join(rt, 'sessions', sid, 'runtime')
    await spawnAndWaitMkdir(meta)
    // PID 0 is invalid -> /proc/0/stat unreadable -> "already gone" branch.
    await writeFile(path.join(meta, 'scode.pid'), '0\n')
    await writeFile(path.join(meta, 'scode.start_ticks'), '0\n')
    const out = await run('/bin/sh', [REAP, sid, '500'], { MOSS_RUNTIME_DIR: rt })
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('already gone')
    expect(existsSync(path.join(meta, 'scode.pid'))).toBe(false)
    await rm(rt, { recursive: true, force: true })
  })

  it('launcher records pid + start_ticks before exec', async () => {
    const rt = await mkdtemp(path.join(tmpdir(), 'moss-launch-record-'))
    const sid = 'session-record'
    // The launcher will exec `sh -c 'sleep 0.3'` so we can inspect the
    // metadata file while it's still running.
    const child = spawn('/bin/sh', [LAUNCH, sid, '--', '/bin/sh', '-c', 'sleep 0.3'], {
      env: { ...process.env, MOSS_RUNTIME_DIR: rt },
    })
    // Wait for pidfile to appear.
    const meta = path.join(rt, 'sessions', sid, 'runtime')
    const pidfile = path.join(meta, 'scode.pid')
    const ticksfile = path.join(meta, 'scode.start_ticks')
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(pidfile) && existsSync(ticksfile)) break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(existsSync(pidfile)).toBe(true)
    expect(existsSync(ticksfile)).toBe(true)
    const pid = Number((await readFile(pidfile, 'utf8')).trim())
    const ticks = (await readFile(ticksfile, 'utf8')).trim()
    expect(pid).toBeGreaterThan(0)
    expect(ticks).toMatch(/^\d+$/)
    // Same source unit as /proc/<pid>/stat field 22.
    const statContent = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
    if (statContent) {
      const field22 = statContent.split(' ')[21]
      expect(field22).toBe(ticks)
    }
    await new Promise<void>(r => child.once('close', () => r()))
    await rm(rt, { recursive: true, force: true })
  })

  it('launcher keeps a stable parent while child process runs', async () => {
    const rt = await mkdtemp(path.join(tmpdir(), 'moss-launch-parent-'))
    const sid = 'session-parent'
    const child = spawn('/bin/sh', [LAUNCH, sid, '--', '/bin/sh', '-c', 'sleep 2'], {
      env: { ...process.env, MOSS_RUNTIME_DIR: rt },
    })

    const meta = path.join(rt, 'sessions', sid, 'runtime')
    const pidfile = path.join(meta, 'scode.pid')
    const ticksfile = path.join(meta, 'scode.start_ticks')
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(pidfile) && existsSync(ticksfile)) break
      await new Promise(r => setTimeout(r, 20))
    }

    expect(existsSync(pidfile)).toBe(true)
    const pid = Number((await readFile(pidfile, 'utf8')).trim())
    expect(pid).toBeGreaterThan(1)

    await new Promise(r => setTimeout(r, 500))
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const ppid = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1] ?? '0')

    expect(ppid).toBeGreaterThan(1)
    expect(ppid).not.toBe(pid)

    const out = await run('/bin/sh', [REAP, sid, '500'], { MOSS_RUNTIME_DIR: rt })
    expect(out.code).toBe(0)
    await waitForClose(child)
    await rm(rt, { recursive: true, force: true })
  })
})

async function spawnAndWaitMkdir(p: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const c = spawn('mkdir', ['-p', p])
    c.on('close', code => (code === 0 ? resolve() : reject(new Error(`mkdir exit ${code}`))))
  })
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => child.once('close', () => resolve()))
}

void stat
