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
  let isClientSkillAvailable = true
  const hub = createServer((req, res) => {
    if (req.url === '/skill.zip' || req.url === '/agent.zip') {
      res.end(req.url === '/skill.zip' ? skillZip : agentZip)
    } else if (req.url === '/api/skills/skill-one') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { skill: { id: 'skill-one', name: 'shared-skill', display_name: 'Shared skill' }, versions: [{ version: '1', source_url: `${hubUrl}/skill.zip` }] } }))
    } else if (req.url === '/api/skills/client-skill') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { skill: { id: 'client-skill', name: 'client-skill', display_name: 'Client skill', enabled: isClientSkillAvailable }, versions: [{ version: '2', source_url: `${hubUrl}/skill.zip` }] } }))
    } else if (req.url === '/api/skills/restricted-skill' || req.url === '/api/skills/pending-skill') {
      const isPending = req.url.includes('pending')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { skill: { id: isPending ? 'pending-skill' : 'restricted-skill', name: 'restricted', ...(isPending ? { status: 0 } : { tenant_id: 'other-org' }) }, versions: [{ version: '1', source_url: `${hubUrl}/skill.zip` }] } }))
    } else if (req.url === '/api/assistants/client-agent') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { assistant: { id: 'client-agent', name: 'client-agent', skills: ['client-skill'], version: '3', sourceUrl: `${hubUrl}/agent.zip` } } }))
    } else if (req.url?.startsWith('/api/skills/cursor')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { skills: [{ id: 'client-skill', name: 'client-skill' }], next_cursor: null, has_more: false } }))
    } else { res.writeHead(404); res.end() }
  })
  // Register cleanup before bundling: a failed build must not leave the HTTP
  // listener alive and hang the entire Node test runner.
  t.after(async () => {
    hub.closeAllConnections()
    if (hub.listening) await new Promise<void>(resolveClose => hub.close(() => resolveClose()))
    await rm(root, { recursive: true, force: true })
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
    await t.test('catalog browsing and installation are available to ordinary users and isolated per user', async () => {
      await ok('POST', '/api/v1/users', a.super, { name: 'a-peer', role: 'user', password: 'test-local-password' })
      const peer = await login('a-peer')
      const catalog = await ok('GET', '/api/v1/skill-hub/skills/cursor?limit=40', a.user)
      assert.equal(catalog.skills[0].id, 'client-skill')
      assert.equal((await ok('GET', '/api/v1/skills/installed', a.user)).some((item: any) => item.id === 'client-skill'), false)
      const install = (token: string, kind: string, id: string) => ok('POST', '/api/v1/client/catalog/install', token, { kind, id, source: 'hub', sourceUrl: 'https://untrusted.invalid/ignored.zip', orgId: b.orgId })
      const prepared = await install(a.user, 'agents', 'client-agent')
      assert.equal(prepared.protocolVersion, 1)
      assert.equal(prepared.resources.length, 2)
      assert.equal((await install(a.user, 'agents', 'client-agent')).preparationId, prepared.preparationId, 'same installed version must reuse the immutable preparation')
      const manifest = await ok('GET', `/api/v1/client/catalog/preparations/${prepared.preparationId}`, a.user)
      isClientSkillAvailable = false
      assert.equal((await request('GET', `/api/v1/client/catalog/preparations/${prepared.preparationId}`, a.user)).status, 404)
      isClientSkillAvailable = true
      assert.equal(manifest.preparationId, prepared.preparationId)
      assert.equal(manifest.snapshot, undefined, 'server paths must not leave the server')
      for (const resource of prepared.resources) {
        assert.match(resource.digest, /^[a-f0-9]{64}$/)
        assert.match(resource.runtimeRef, /^moss-prepared:/)
        const bytes = await ok('GET', resource.downloadRef, a.user)
        assert.ok(Buffer.isBuffer(bytes))
        assert.equal((await request('GET', resource.downloadRef, peer)).status, 404)
        assert.equal((await request('GET', resource.downloadRef, b.user)).status, 404)
      }

      for (const [kind, id] of [['skills', 'client-skill'], ['agents', 'client-agent']]) {
        const own = (await ok('GET', `/api/v1/${kind}/installed`, a.user)).find((item: any) => item.id === id)
        assert.ok(own, `${kind} must be installed for the caller`)
        const zip = await JSZip.loadAsync(await ok('GET', `/api/v1/${kind}/installed/${id}/download`, a.user))
        assert.ok(zip.file('_moss_meta.json'))
        for (const other of [peer, b.user]) {
          assert.equal((await ok('GET', `/api/v1/${kind}/installed`, other)).some((item: any) => item.id === id), false)
          assert.equal((await request('GET', `/api/v1/${kind}/installed/${id}/download`, other)).status, 404)
        }
      }
      await install(peer, 'skills', 'client-skill')
      const first = (await ok('GET', '/api/v1/skills/installed', a.user)).find((item: any) => item.id === 'client-skill')
      const second = (await ok('GET', '/api/v1/skills/installed', peer)).find((item: any) => item.id === 'client-skill')
      assert.notEqual(first.meta.installation_id, second.meta.installation_id)
      await install(a.user, 'skills', 'client-skill')
      assert.equal((await ok('GET', '/api/v1/skills/installed', a.user)).filter((item: any) => item.id === 'client-skill').length, 1)
      assert.equal((await request('POST', '/api/v1/client/catalog/install', peer, { kind: 'skills', id: 'client-skill', source: 'tenant' })).status, 404)
      assert.equal((await request('POST', '/api/v1/client/catalog/install', undefined, { kind: 'skills', id: 'client-skill', source: 'hub' })).status, 401)
      assert.equal((await request('POST', '/api/v1/skills/install', peer, { skillName: 'arbitrary' })).status, 403)
      for (const id of ['restricted-skill', 'pending-skill']) {
        assert.equal((await request('POST', '/api/v1/client/catalog/install', peer, { kind: 'skills', id, source: 'hub' })).status, 404)
      }
    })
    await t.test('private/custom resources cannot be read or managed from another organization', async () => {
      const agent = await ok('POST', '/api/v1/agents/tenant/create', a.admin, { name: 'private-agent', display_name: 'Private A', rules: 'A private prompt', visible_to: null })
      const skill = await ok('POST', '/api/v1/skills/tenant/upload', a.admin, { entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: private-skill\ndescription: private\n---\nprivate').toString('base64') }], visible_to: null })
      const custom = await ok('POST', '/api/v1/skills/custom', a.user, { file: skillZip.toString('base64'), name: 'custom-skill', displayName: 'Custom A' })
      assert.match((await ok('GET', `/api/v1/skills/tenant/${skill.id}/content`, a.user)).content, /private/)
      assert.equal((await ok('GET', `/api/v1/agents/tenant/${agent.data.id}/rules`, a.user)).rules, 'A private prompt')
      for (const [type, id] of [['agents', agent.data.id], ['skills', skill.id]]) {
        const own = await ok('GET', `/api/v1/${type}/tenant?status=approved`, a.user)
        assert.ok(own.some((row: any) => row.id === id), 'The tenant catalog includes accessible resources before a desktop download')
        const other = await ok('GET', `/api/v1/${type}/tenant?status=approved`, b.user)
        assert.equal(other.some((row: any) => row.id === id), false)
      }
      for (const token of [b.user, b.admin, b.super]) {
        assert.equal((await request('GET', `/api/v1/skills/tenant/${skill.id}/content`, token)).status, 404)
        for (const [type, id] of [['agents', agent.data.id], ['skills', skill.id]]) {
          assert.equal((await request('GET', `/api/v1/${type}/tenant/${id}/download`, token)).status, 404)
          assert.equal((await request('PATCH', `/api/v1/${type}/tenant/${id}`, token, { enabled: false })).status, 404)
          assert.equal((await request('DELETE', `/api/v1/${type}/tenant/${id}`, token)).status, 404)
          assert.equal((await request('POST', '/api/v1/client/catalog/install', token, { kind: type, id, source: 'tenant' })).status, 404)
          assert.equal((await ok('GET', `/api/v1/${type}/installed`, token)).some((row: any) => row.id === id), false)
        }
        assert.equal((await request('GET', `/api/v1/skills/installed/${custom.id}/download`, token)).status, 404)
      }
      assert.equal((await request('GET', `/api/v1/agents/tenant/${agent.data.id}/rules`, b.admin)).status, 404)
      assert.equal((await request('POST', `/api/v1/admin/agents/tenant/${agent.data.id}/approve`, b.admin, { approved: false })).status, 404)
      assert.equal((await request('PATCH', '/api/v1/agents/meta', b.admin, { assistantName: 'agent-one', updates: { enabledSkills: [skill.id] } })).status, 404)
      assert.ok(Buffer.isBuffer(await ok('GET', `/api/v1/skills/installed/${custom.id}/download`, a.user)))
      const beforeTenantInstall = (await ok('GET', '/api/v1/skills/installed', a.user)).length
      await ok('POST', '/api/v1/client/catalog/install', a.user, { kind: 'skills', id: skill.id, source: 'tenant' })
      assert.equal((await ok('GET', '/api/v1/skills/installed', a.user)).length, beforeTenantInstall)
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
  }
})
