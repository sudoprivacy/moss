import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import JSZip from 'jszip'

type Result = { status: number; data: any }
void test('real HTTP: A/B installs, private resources and super-admin organization switching', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-org-routes-'))
  const skillZip = await new JSZip().file('SKILL.md', '---\nname: shared-skill\ndescription: fixture\n---\nSkill one').generateAsync({ type: 'nodebuffer' })
  const agentZip = await new JSZip().file('system.md', 'Original shared prompt').generateAsync({ type: 'nodebuffer' })
  const hub = createServer((req, res) => {
    if (req.url === '/skill.zip' || req.url === '/agent.zip') {
      res.end(req.url === '/skill.zip' ? skillZip : agentZip)
    } else if (req.url === '/api/skills/skill-one') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { skill: { id: 'skill-one', name: 'shared-skill', display_name: 'Shared skill' }, versions: [{ version: '1', source_url: `${hubUrl}/skill.zip` }] } }))
    } else { res.writeHead(404); res.end() }
  })
  hub.listen(0, '127.0.0.1'); await once(hub, 'listening')
  const hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`
  const configPath = join(root, 'server.json')
  await writeFile(configPath, JSON.stringify({
    server: { host: '127.0.0.1', port: 0 },
    bootstrapAdmin: { username: 'test-root', password: 'test-local-password' },
    storage: { rootDir: root, dbPath: join(root, 'moss.db'), transcriptDir: join(root, 'transcripts'), runtimeDir: join(root, 'runtime') },
    wikiIndex: { enabled: false },
  }))
  const repo = resolve(import.meta.dirname, '../../..')
  execFileSync('bun', ['build', 'src/server/tenantAssistantRoutes.fixture.ts', '--target=node', '--format=esm', '--outdir', join(root, 'build'), '--external=sharp', '--external=@xenova/transformers', '--external=onnxruntime-node'], { cwd: repo, stdio: 'pipe' })
  const child = spawn(process.execPath, [join(root, 'build/tenantAssistantRoutes.fixture.js')], {
    cwd: repo, env: { ...process.env, MOSS_HOME: join(root, 'moss-home'), MOSS_SERVER_CONFIG: configPath, MOSS_HUB_API_BASE_URL: hubUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${errors}`)), 20_000)
      child.stdout.on('data', () => {
        const match = output.match(/TENANT_TEST_READY:(\d+)/)
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])) }
      })
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exit ${code}: ${errors}`)) })
    })
    const base = `http://127.0.0.1:${port}`
    async function request(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
      const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: response.status, data: response.headers.get('content-type')?.includes('application/zip') ? Buffer.from(await response.arrayBuffer()) : await response.json() }
    }
    async function ok(method: string, path: string, token?: string, body?: unknown) {
      const response = await request(method, path, token, body)
      assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.data)}\n${errors.slice(-2000)}`)
      return response.data
    }
    async function login(name: string) { return (await ok('POST', '/api/v1/auth/token', undefined, { username: name, password: 'test-local-password' })).access_token as string }
    const boot = await login('test-root')
    const accounts: Record<string, { orgId: string; admin: string; user: string; super: string }> = {}
    for (const label of ['a', 'b']) {
      const org = await ok('POST', '/api/v1/organizations', boot, { name: label })
      const switched = await ok('POST', '/api/v1/auth/switch-org', boot, { org_id: org.organization.id })
      const account = { orgId: org.organization.id, admin: '', user: '', super: switched.access_token }
      for (const role of ['admin', 'user'] as const) {
        await ok('POST', '/api/v1/users', switched.access_token, { name: `${label}-${role}`, role, password: 'test-local-password' })
        account[role] = await login(`${label}-${role}`)
      }
      accounts[label] = account
    }
    const a = accounts.a!, b = accounts.b!
    const installSkill = (token: string, version = '') => ok('POST', '/api/v1/skills/install', token, { skillName: 'shared-skill', sourceUrl: `${hubUrl}/skill.zip`, version, skillMeta: { id: 'skill-one', name: 'shared-skill' } })
    const installAgent = (token: string) => ok('POST', '/api/v1/agents/install', token, { assistantName: 'shared-agent', sourceUrl: `${hubUrl}/agent.zip`, assistantMeta: { id: 'agent-one', name: 'shared-agent', skills: ['skill-one'] }, selectedSkillIds: ['skill-one'] })
    await t.test('a rejected package never creates an installation', async () => {
      const failed = await request('POST', '/api/v1/skills/install', b.admin, { skillName: 'broken', sourceUrl: `${hubUrl}/skill.zip`, checksum: 'incorrect', skillMeta: { id: 'broken', name: 'broken' } })
      assert.ok(failed.status >= 400)
      assert.deepEqual(await ok('GET', '/api/v1/skills/installed', b.admin), [])
    })
    await t.test('A installs one of each; B remains empty including switched super-admin', async () => {
      await Promise.all(Array.from({ length: 4 }, () => installSkill(a.admin)))
      await installAgent(a.admin)
      for (const type of ['agents', 'skills']) {
        assert.equal((await ok('GET', `/api/v1/${type}/installed`, a.admin)).length, 1)
        assert.deepEqual(await ok('GET', `/api/v1/${type}/installed`, b.admin), [])
        assert.deepEqual(await ok('GET', `/api/v1/${type}/installed`, b.super), [])
      }
      assert.equal((await request('GET', '/api/v1/agents/installed/agent-one/download', b.user)).status, 404)
      // Rejected before launching any model or runner.
      assert.equal((await request('POST', '/api/v1/sessions', b.user, { assistant_name: 'agent-one' })).status, 404)
    })
    await t.test('B agent installation installs B dependencies even when A cached them', async () => {
      await installAgent(b.admin)
      assert.equal((await ok('GET', '/api/v1/skills/installed', b.admin)).length, 1)
      const aSkills = await ok('GET', '/api/v1/skills/installed', a.admin)
      const bSkills = await ok('GET', '/api/v1/skills/installed', b.admin)
      assert.equal(aSkills[0].id, bSkills[0].id)
      assert.notEqual(aSkills[0].meta.installation_id, bSkills[0].meta.installation_id)
    })
    await t.test('settings, version and uninstall are organization-local', async () => {
      await ok('PATCH', '/api/v1/agents/meta', a.admin, { assistantName: 'agent-one', updates: { rules: 'A prompt only' } })
      assert.equal((await ok('GET', '/api/v1/agents/installed/agent-one/rules', b.admin)).rules, 'Original shared prompt')
      assert.equal((await ok('GET', '/api/v1/agents/installed/agent-one/rules', a.admin)).rules, 'A prompt only')
      const zip = await JSZip.loadAsync(await ok('GET', '/api/v1/agents/installed/agent-one/download', a.admin))
      assert.equal(await zip.file('system.md')!.async('string'), 'A prompt only')
      await installSkill(a.admin, '2')
      assert.notEqual((await ok('GET', '/api/v1/skills/installed', b.admin))[0].version, '2')
      await ok('PATCH', '/api/v1/skills/enabled', a.admin, { skillName: 'skill-one', enabled: false })
      assert.equal((await ok('GET', '/api/v1/skills/installed', b.admin))[0].enabled, true)
      const skillPackage = await JSZip.loadAsync(await ok('GET', '/api/v1/skills/installed/skill-one/download', a.admin))
      assert.equal(JSON.parse(await skillPackage.file('_moss_meta.json')!.async('string')).enabled, false)
      assert.equal((await request('POST', '/api/v1/skills/uninstall', a.admin, { skillName: 'skill-one' })).status, 409)
      await ok('POST', '/api/v1/agents/uninstall', a.admin, { assistantName: 'agent-one' })
      await ok('POST', '/api/v1/skills/uninstall', a.admin, { skillName: 'skill-one' })
      assert.deepEqual(await ok('GET', '/api/v1/agents/installed', a.admin), [])
      assert.equal((await ok('GET', '/api/v1/agents/installed', b.admin)).length, 1)
      assert.ok(Buffer.isBuffer(await ok('GET', '/api/v1/skills/installed/skill-one/download', b.user)))
    })
    await t.test('private/custom resources cannot be read or managed from another organization', async () => {
      const agent = await ok('POST', '/api/v1/agents/tenant/create', a.admin, { name: 'private-agent', display_name: 'Private A', rules: 'A private prompt', visible_to: null })
      const skill = await ok('POST', '/api/v1/skills/tenant/upload', a.admin, { entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: private-skill\ndescription: private\n---\nprivate').toString('base64') }], visible_to: null })
      const custom = await ok('POST', '/api/v1/skills/custom', a.user, { file: skillZip.toString('base64'), name: 'custom-skill', displayName: 'Custom A' })
      for (const token of [b.user, b.admin, b.super]) {
        for (const [type, id] of [['agents', agent.data.id], ['skills', skill.id]]) {
          assert.equal((await request('GET', `/api/v1/${type}/tenant/${id}/download`, token)).status, 404)
          assert.equal((await request('PATCH', `/api/v1/${type}/tenant/${id}`, token, { enabled: false })).status, 404)
          assert.equal((await request('DELETE', `/api/v1/${type}/tenant/${id}`, token)).status, 404)
          assert.equal((await ok('GET', `/api/v1/${type}/installed`, token)).some((row: any) => row.id === id), false)
        }
        assert.equal((await request('GET', `/api/v1/skills/installed/${custom.id}/download`, token)).status, 404)
      }
      assert.equal((await request('GET', `/api/v1/agents/tenant/${agent.data.id}/rules`, b.admin)).status, 404)
      assert.equal((await request('POST', `/api/v1/admin/agents/tenant/${agent.data.id}/approve`, b.admin, { approved: false })).status, 404)
      assert.equal((await request('PATCH', '/api/v1/agents/meta', b.admin, { assistantName: 'agent-one', updates: { enabledSkills: [skill.id] } })).status, 404)
      assert.ok(Buffer.isBuffer(await ok('GET', `/api/v1/skills/installed/${custom.id}/download`, a.user)))
      // Publishing preserves custom originals and does not duplicate their DB ID.
      const publication = await ok('POST', '/api/v1/skills/tenant/publish', a.user, { skillId: custom.id })
      await ok('POST', `/api/v1/admin/skills/tenant/${publication.id}/approve`, a.admin, { approved: true })
      assert.ok(Buffer.isBuffer(await ok('GET', `/api/v1/skills/tenant/${publication.id}/download`, a.admin)))
      // A same-name private object in B cannot overwrite A's package.
      await ok('POST', '/api/v1/agents/tenant/create', b.admin, { name: 'private-agent', display_name: 'Private B', rules: 'B private prompt' })
      assert.equal((await ok('GET', `/api/v1/agents/tenant/${agent.data.id}/rules`, a.admin)).rules, 'A private prompt')
    })
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    await new Promise<void>(resolveClose => hub.close(() => resolveClose()))
    await rm(root, { recursive: true, force: true })
  }
})
