import { describe, expect, it, spyOn } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearModelCache, prepareScodeModel } from '../modelListCache.js'
import { getDefaultServerConfig, readServerConfig } from '../config.js'

describe('cabin runtime policy', () => {
  it('never fetches a catalog for fixed models; non-cabin sessions can still discover models', async () => {
    clearModelCache()
    const catalog = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true, data: [{ model_id: 'other' }] }))
    try {
      for (const model of ['local', '/opt/models/qwen', 'proxy/local', 'opus']) {
        const { models, alias } = await prepareScodeModel('http://local/v1', model, true)
        expect(Object.keys(models)).toEqual([alias])
        expect(models[alias]).toMatchObject({ providers: { proxy: { model: model.replace(/^proxy\//, '') } } })
      }
      await expect(prepareScodeModel('', 'local', true)).rejects.toThrow()
      expect(catalog).not.toHaveBeenCalled()
      expect((await prepareScodeModel('http://local/v1', 'local')).models).toHaveProperty('proxy/other')
      expect(catalog).toHaveBeenCalledTimes(1)
    } finally { catalog.mockRestore(); clearModelCache() }
  })

  it('loads explicit recovery limits including false and zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cabin-config-'))
    try {
      const file = join(dir, 'server.json')
      const value = getDefaultServerConfig()
      const policy = { replyTimeoutMs: 1200, sessionRecoveryEnabled: false, sessionRecoveryMaxAttempts: 0, contextReplayTurns: 0, serviceOrderCreateEnabled: false }
      await writeFile(file, JSON.stringify({ ...value, cabin: { ...value.cabin, ...policy } }))
      expect((await readServerConfig(file)).config.cabin).toMatchObject(policy)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('runs the actual host, docker run and docker exec argument builders against fake executables only', async () => {
    for (const mode of ['host', 'session', 'user']) {
      const dir = await mkdtemp(join(tmpdir(), 'cabin-launch-'))
      try {
        const cli = join(dir, mode === 'host' ? 'scode' : 'docker')
        await writeFile(cli, `#!/bin/sh\ncase "$1" in run|exec|acp) ;; *) exit 0;; esac\ncase "$*" in *--model*) ;; *) exit 0;; esac\nprintf '%s\\n' "$@" > "$HOME_CAPTURE/args"\nprintf '%s\\n' "$CABIN_CONTROL_MODE" "$MOSS_CABIN_MANAGED" "${'${CABIN_CONTROL_AUTH-unset}'}" > "$HOME_CAPTURE/env"\n/bin/cp "$HOME_CAPTURE/scode-home/sudocode.json" "$HOME_CAPTURE/config.json"\nread -r ignored\n`)
        await chmod(cli, 0o700)
        const script = `import {DockerBackend} from './src/server/backends/dockerBackend.ts'; import {ScodeBackend} from './src/server/backends/scodeBackend.ts';
          globalThis.fetch=()=>{throw Error('unexpected network')};
          const dir=process.env.HOME_CAPTURE, mode=process.env.TEST_MODE;
          const backend=mode==='host'?new ScodeBackend():new DockerBackend();
          const handle=await backend.spawn({sessionId:'test',cabinManaged:true,cwd:dir,enabledSkillNames:[],runtime:{type:mode==='host'?'host':'docker',engine:'scode',dockerImage:'fake',containerMode:mode,configDir:dir+'/config',scodeHomeDir:dir+'/scode-home',userContainerName:'fixture',scodePath:dir+'/scode'}});
          await new Promise(resolve=>handle.onExit(resolve));`
        const child = Bun.spawn([process.execPath, '-e', script], { env: { PATH: dir, HOME: dir, HOME_CAPTURE: dir, TEST_MODE: mode, MOSS_HOME: dir, MOSS_DEFAULT_MODEL: '/models/test', ANTHROPIC_BASE_URL: 'http://local/v1', ANTHROPIC_API_KEY: 'fixture', CABIN_CONTROL_AUTH: 'not-for-runner' }, stdout: 'ignore', stderr: 'pipe' })
        const diagnostic = await new Response(child.stderr).text()
        if (await child.exited !== 0) throw new Error(diagnostic)
        const args = (await readFile(join(dir, 'args'), 'utf8')).trim().split('\n')
        expect(args[0]).toBe(mode === 'host' ? 'acp' : mode === 'session' ? 'run' : 'exec')
        expect(args[args.indexOf('--model') + 1]).toBe('proxy//models/test')
        const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
        expect(Object.keys(config.models)).toEqual(['proxy//models/test'])
        expect(config.auth_modes.proxy['moss-proxy'].baseUrl).toBe('http://local/v1')
        expect((await readFile(join(dir, 'env'), 'utf8')).trim()).toBe('emit\n1\nunset')
        if (mode !== 'host') {
          expect(args).toContain('CABIN_CONTROL_MODE=emit')
          expect(args).toContain('MOSS_CABIN_MANAGED=1')
          expect(args.join(' ')).not.toContain('not-for-runner')
        }
      } finally { await rm(dir, { recursive: true, force: true }) }
    }
  }, 15000)

  it('emits validated commands without control credentials and refuses managed execute', async () => {
    for (const mode of ['emit', 'execute', '']) {
      const child = Bun.spawn([process.execPath, 'skills/hub/cabin-hardware-control/scripts/cabin-control.mjs', '--command', 'seat.tray.open', '--seat-no', 'A'], { env: { MOSS_CABIN_MANAGED: '1', CABIN_CONTROL_MODE: mode }, stdout: 'pipe' })
      const payload = await new Response(child.stdout).json()
      expect(await child.exited).toBe(mode === 'emit' ? 0 : 1)
      expect(payload).toMatchObject(mode === 'emit' ? { mode, ok: true, command: 'seat.tray.open' } : { ok: false, code: 'INVALID_MODE' })
    }
  })
})
