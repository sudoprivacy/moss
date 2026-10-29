import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import JSZip from 'jszip'
import { waitForFixtureReady } from '../testing/fixtureReady.js'

type Result = { status: number; data: any }
void test('real HTTP: A/B installs, private resources and super-admin organization switching', { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'moss-org-routes-'))
  const script = '#!/bin/sh\nprintf resource-ready\n'
  const skillZip = await new JSZip().file('SKILL.md', '---\nname: shared-skill\ndescription: fixture\n---\nSkill one')
    .file('scripts/run.sh', script, { unixPermissions: 0o100755 }).generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
  const agentZip = await new JSZip().file('system.md', 'Original shared prompt')
    .file('scripts/run.sh', script, { unixPermissions: 0o100755 }).generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
  const assertExecutableArchive = async (bytes: Buffer) => {
    const zip = await JSZip.loadAsync(bytes)
    const entry = zip.file('scripts/run.sh')!
    assert.ok(entry, 'Resource copies must retain their executable assets')
    assert.equal(await entry.async('string'), script)
    if (process.platform !== 'win32') assert.equal(Number(entry.unixPermissions) & 0o7777, 0o700)
  }
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
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction')
  execFileSync('bun', ['build', 'src/server/tenantAssistantRoutes.fixture.ts', '--target=node', '--format=esm', '--external=@sudo/contracts/common/v1/resource-ref', '--outdir', join(root, 'build'), '--external=sharp', '--external=@xenova/transformers', '--external=onnxruntime-node'], { cwd: repo, stdio: 'pipe' })
  const child = spawn(process.execPath, [join(root, 'build/tenantAssistantRoutes.fixture.js')], {
    cwd: repo, env: { ...process.env, MOSS_HOME: join(root, 'moss-home'), MOSS_SERVER_CONFIG: configPath, MOSS_HUB_API_BASE_URL: hubUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  try {
    const port = await waitForFixtureReady(child, /TENANT_TEST_READY:(\d+)/,
      () => ({ output, errors }), t.signal)
    const base = `http://127.0.0.1:${port}`
    async function request(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
      const response = await fetch(base + path, { method, signal: t.signal, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
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
    const installAgent = (token: string) => ok('POST', '/api/v1/agent-templates/install', token, { assistantName: 'shared-agent', sourceUrl: `${hubUrl}/agent.zip`, assistantMeta: { id: 'agent-one', name: 'shared-agent', skills: ['skill-one'] }, selectedSkillIds: ['skill-one'] })
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
      assert.equal((await request('GET', '/api/v1/agent-templates/installed/agent-one/download', b.user)).status, 404)
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
    await t.test('template URL aliases keep organization permissions and archive identity', async () => {
      for (const segment of ['agents', 'agent-templates']) {
        assert.equal((await request('GET', `/api/v1/${segment}/installed`)).status, 401)
        const installed = await ok('GET', `/api/v1/${segment}/installed`, a.admin)
        assert.equal(installed[0].id, 'agent-one')
        assert.equal((await request('PATCH', `/api/v1/${segment}/meta`, a.user, { assistantName: 'agent-one', updates: { rules: 'denied' } })).status, 403)
        assert.equal((await request('GET', `/api/v1/${segment}/tenant/missing/download`, b.user)).status, 404)
      }
      const oldArchive = await ok('GET', '/api/v1/agents/installed/agent-one/download', a.admin)
      const newArchive = await ok('GET', '/api/v1/agent-templates/installed/agent-one/download', a.admin)
      await assertExecutableArchive(newArchive)
      const [oldZip, newZip] = await Promise.all([JSZip.loadAsync(oldArchive), JSZip.loadAsync(newArchive)])
      assert.equal(await oldZip.file('system.md')!.async('string'), await newZip.file('system.md')!.async('string'))
      assert.equal((await request('GET', '/api/v1/agents/private-archives', a.user)).status, 200)
      assert.equal((await request('GET', '/api/v1/agent-templates/private-archives', a.user)).status, 404)
    })
    await t.test('settings, version and uninstall are organization-local', async () => {
      await ok('PATCH', '/api/v1/agent-templates/meta', a.admin, { assistantName: 'agent-one', updates: { rules: 'A prompt only' } })
      assert.equal((await ok('GET', '/api/v1/agent-templates/installed/agent-one/rules', b.admin)).rules, 'Original shared prompt')
      assert.equal((await ok('GET', '/api/v1/agent-templates/installed/agent-one/rules', a.admin)).rules, 'A prompt only')
      const zip = await JSZip.loadAsync(await ok('GET', '/api/v1/agent-templates/installed/agent-one/download', a.admin))
      assert.equal(await zip.file('system.md')!.async('string'), 'A prompt only')
      await installSkill(a.admin, '2')
      assert.notEqual((await ok('GET', '/api/v1/skills/installed', b.admin))[0].version, '2')
      await ok('PATCH', '/api/v1/skills/enabled', a.admin, { skillName: 'skill-one', enabled: false })
      assert.equal((await ok('GET', '/api/v1/skills/installed', b.admin))[0].enabled, true)
      const skillBytes = await ok('GET', '/api/v1/skills/installed/skill-one/download', a.admin)
      await assertExecutableArchive(skillBytes)
      const skillPackage = await JSZip.loadAsync(skillBytes)
      assert.equal(JSON.parse(await skillPackage.file('_moss_meta.json')!.async('string')).enabled, false)
      assert.equal((await request('POST', '/api/v1/skills/uninstall', a.admin, { skillName: 'skill-one' })).status, 409)
      await ok('POST', '/api/v1/agent-templates/uninstall', a.admin, { assistantName: 'agent-one' })
      await ok('POST', '/api/v1/skills/uninstall', a.admin, { skillName: 'skill-one' })
      assert.deepEqual(await ok('GET', '/api/v1/agent-templates/installed', a.admin), [])
      assert.equal((await ok('GET', '/api/v1/agent-templates/installed', b.admin)).length, 1)
      assert.ok(Buffer.isBuffer(await ok('GET', '/api/v1/skills/installed/skill-one/download', b.user)))
    })
    await t.test('ordinary users import portable desktop assets with metadata, dependencies and private ownership', async () => {
      const bytes = await new JSZip().file('SKILL.md', '---\nname: desktop-skill\ndescription: formula\nversion: 1.2.0\n---\nAdd 5%.')
        .file('_moss_meta.json', JSON.stringify({ display_name: '桌面技能', description: 'portable description', installed_version: '1.2.0', author_id: 'forged', visible_to: null }))
        .generateAsync({ type: 'nodebuffer' })
      for (const account of [a, b]) {
        const imported = await ok('POST', '/api/v1/skills/import/archive', account.user, { fileName: 'renamed-package.zip', archiveBase64: bytes.toString('base64') })
        assert.equal(imported.skillName, 'desktop-skill')
        const skills = await ok('GET', '/api/v1/skills/installed', account.user)
        const skill = skills.find((row: any) => row.name === 'desktop-skill')
        assert.equal(skill.displayName, '桌面技能')
        assert.equal(skill.description, 'portable description')
        const agentBytes = await new JSZip().file('AGENT.md', 'Use desktop-skill.').file('_moss_meta.json', JSON.stringify({ display_name: '桌面专家', description: 'expert description', installed_version: '2.3.0', ruleFile: 'AGENT.md', skills: ['desktop-skill'], enabledSkills: ['desktop-skill'] })).generateAsync({ type: 'nodebuffer' })
        const expert = await ok('POST', '/api/v1/agent-templates/custom', account.user, { name: 'renamed-expert', file: agentBytes.toString('base64') })
        assert.equal(expert.name, '桌面专家')
        assert.equal(expert.version, '2.3.0')
        const installed = (await ok('GET', '/api/v1/agent-templates/installed', account.user)).find((row: any) => row.id === expert.id)
        assert.deepEqual(installed.meta.enabledSkills, [skill.id])
        assert.equal((await ok('GET', `/api/v1/agent-templates/installed/${expert.id}/rules`, account.user)).rules, 'Use desktop-skill.')
        assert.equal((await request('GET', `/api/v1/agent-templates/installed/${expert.id}/download`, account.admin)).status, 404, 'Same-org administrators review submitted copies, not personal working assets')
        assert.equal((await request('GET', `/api/v1/skills/installed/${skill.id}/download`, account.admin)).status, 404)
        const other = account === a ? b : a
        assert.equal((await request('GET', `/api/v1/agent-templates/installed/${expert.id}/download`, other.user)).status, 404)
        assert.equal((await request('POST', '/api/v1/agent-templates/tenant/publish', account.user, { assistantId: expert.id })).status, 409, 'Private skill dependencies must be published first')
        const skillPublication = await ok('POST', '/api/v1/skills/tenant/publish', account.user, { skillId: skill.id })
        await ok('POST', `/api/v1/admin/skills/tenant/${skillPublication.id}/approve`, account.admin, { approved: true })
        const publication = await ok('POST', '/api/v1/agent-templates/tenant/publish', account.user, { assistantId: expert.id })
        assert.equal(publication.status, 'pending')
      }
    })
    await t.test('development assets keep identity across repeated uploads/imports, freeze submissions, and replace one published version', async () => {
      const skillKey = '11111111-1111-4111-8111-111111111111'
      const agentKey = '22222222-2222-4222-8222-222222222222'
      const archive = async (kind: string, key: string, version: string) => new JSZip()
        .file(kind === 'skill' ? 'SKILL.md' : 'AGENT.md', kind === 'skill' ? `---\nname: continuous-skill\n---\ncontent-${version}` : `expert-${version}`)
        .file('_moss_meta.json', JSON.stringify({ transfer_asset_key: key, name: kind === 'skill' ? 'continuous-skill' : 'Continuous expert', display_name: kind === 'skill' ? 'Continuous skill' : 'Continuous expert', installed_version: version, ruleFile: kind === 'skill' ? undefined : 'AGENT.md', skills: kind === 'skill' ? [] : ['continuous-skill'] }))
        .generateAsync({ type: 'nodebuffer' })
      const uploadSkill = async (version: string) => ok('POST', '/api/v1/skills/custom', a.user, { name: 'continuous-skill', displayName: 'Continuous skill', file: (await archive('skill', skillKey, version)).toString('base64') })
      const uploadAgent = async (version: string) => ok('POST', '/api/v1/agent-templates/custom', a.user, { name: 'Continuous expert', file: (await archive('agent', agentKey, version)).toString('base64') })
      const skill = await uploadSkill('1.0.0'), expert = await uploadAgent('1.0.0')
      const publishedIds: Record<string, string> = {}
      const controller = new AbortController()
      const stream = await fetch(`${base}/api/v1/client/catalog/events`, { headers: { Authorization: `Bearer ${a.user}` }, signal: controller.signal })
      const reader = stream.body!.getReader()
      assert.match(new TextDecoder().decode((await reader.read()).value), /catalog.changed/)
      try {
        for (const [kind, sourceId] of [['skills', skill.id], ['agent-templates', expert.id]]) {
          const submit = () => ok('POST', `/api/v1/${kind}/tenant/publish`, a.user, kind === 'skills' ? { skillId: sourceId } : { assistantId: sourceId })
          const first = await submit()
          assert.equal((await request('POST', `/api/v1/admin/${kind}/tenant/${first.id}/approve`, a.user, { approved: true })).status, 403)
          await ok('POST', `/api/v1/admin/${kind}/tenant/${first.id}/approve`, a.admin, { approved: true, visible_to: null })
          publishedIds[kind] = first.id
          assert.match(new TextDecoder().decode((await reader.read()).value), /catalog.changed/)
          const updated = kind === 'skills' ? await uploadSkill('2.0.0') : await uploadAgent('2.0.0')
          assert.equal(updated.id, sourceId)
          const second = await submit()
          // Editing the local working copy after submission must not alter the review snapshot.
          const thirdUpload = kind === 'skills' ? await uploadSkill('3.0.0') : await uploadAgent('3.0.0')
          assert.equal(thirdUpload.id, sourceId)
          const contentRoute = kind === 'skills' ? 'content' : 'rules'
          const pending = await ok('GET', `/api/v1/${kind}/tenant/${second.id}/${contentRoute}`, a.user)
          assert.match(pending.content || pending.rules, /2.0.0/)
          const before = await ok('GET', `/api/v1/${kind}/tenant/${first.id}/${contentRoute}`, a.user)
          assert.match(before.content || before.rules, /1.0.0/)
          assert.equal((await request('PATCH', `/api/v1/${kind}/tenant/${first.id}`, a.user, { display_name: 'forbidden published edit' })).status, 403, 'Even the original author edits only My working copies')
          assert.equal((await request('DELETE', `/api/v1/${kind}/tenant/${first.id}`, a.user)).status, 403)
          const published = await ok('POST', `/api/v1/admin/${kind}/tenant/${second.id}/approve`, a.admin, { approved: true, visible_to: null })
          assert.equal(published.id, first.id)
          assert.match(new TextDecoder().decode((await reader.read()).value), /catalog.changed/)
          const rows = await ok('GET', `/api/v1/${kind}/tenant?status=approved`, a.user)
          assert.equal(rows.filter((row: any) => row.id === first.id).length, 1)
          const after = await ok('GET', `/api/v1/${kind}/tenant/${first.id}/${contentRoute}`, a.user)
          assert.match(after.content || after.rules, /2.0.0/)
          const installed = await ok('GET', `/api/v1/${kind}/installed`, a.user)
          assert.equal(installed.filter((row: any) => row.id === sourceId).length, 1)
        }
      } finally { controller.abort(); await reader.cancel().catch(() => {}) }
      const publishedExpert = (await ok('GET', '/api/v1/agent-templates/tenant', a.user)).find((row: any) => row.id === publishedIds['agent-templates'])
      assert.deepEqual(publishedExpert.enabled_skills, [publishedIds.skills])
      // Another owner importing the same portable key gets their own identity, then updates it.
      for (const version of ['1.0.0', '2.0.0']) {
        await ok('POST', '/api/v1/skills/import/archive', b.user, { fileName: 'renamed.zip', archiveBase64: (await archive('skill', skillKey, version)).toString('base64') })
        await ok('POST', '/api/v1/agent-templates/custom', b.user, { name: 'renamed', file: (await archive('agent', agentKey, version)).toString('base64') })
      }
      const importedSkills = (await ok('GET', '/api/v1/skills/installed', b.user)).filter((row: any) => row.name === 'continuous-skill')
      assert.equal(importedSkills.length, 1); assert.notEqual(importedSkills[0].id, skill.id)
      const importedExperts = (await ok('GET', '/api/v1/agent-templates/installed', b.user)).filter((row: any) => row.name === 'Continuous expert')
      assert.equal(importedExperts.length, 1); assert.notEqual(importedExperts[0].id, expert.id)
      assert.deepEqual(importedExperts[0].meta.skills, [importedSkills[0].id])
      assert.equal((await request('POST', '/api/v1/agent-templates/custom', b.user, { targetId: expert.id, name: 'forged', file: (await archive('agent', agentKey, '4.0.0')).toString('base64') })).status, 403)
      await ok('PATCH', `/api/v1/skills/custom/${skill.id}`, a.user, { content: 'owner edit', displayName: 'Owner skill', description: 'edited' })
      assert.equal((await ok('GET', `/api/v1/skills/custom/${skill.id}`, a.user)).content, 'owner edit')
      assert.equal((await request('PATCH', `/api/v1/skills/custom/${skill.id}`, a.admin, { content: 'not mine' })).status, 404)
      // An admin's edit is owned by that admin and updates the same published ID.
      const draft = await ok('POST', `/api/v1/catalog/skills/tenant/${publishedIds.skills}/draft`, a.admin, {})
      await ok('PATCH', `/api/v1/skills/tenant/${draft.id}`, a.admin, { content: 'admin revision' })
      const draftRow = (await ok('GET', '/api/v1/skills/tenant', a.admin)).find((row: any) => row.id === draft.id)
      assert.ok(draftRow.author_id)
      await ok('POST', '/api/v1/skills/tenant/publish', a.admin, { skillId: draft.id })
      assert.equal((await ok('POST', `/api/v1/admin/skills/tenant/${draft.id}/approve`, a.admin, { approved: true })).id, publishedIds.skills)
      await ok('POST', '/api/v1/agent-templates/create', a.user, { name: 'my-removable-expert', displayName: 'My removable expert', rules: 'private' })
      const removable = (await ok('GET', '/api/v1/agent-templates/installed', a.user)).find((row: any) => row.name === 'my-removable-expert')
      assert.ok(removable)
      await ok('POST', '/api/v1/agent-templates/uninstall', a.user, { assistantName: removable.id })
      await ok('PATCH', '/api/v1/skills/enabled', a.user, { skillName: skill.id, enabled: false })
      await ok('PATCH', '/api/v1/skills/enabled', a.user, { skillName: skill.id, enabled: true })
      assert.equal((await request('PATCH', '/api/v1/skills/enabled', a.user, { skillName: publishedIds.skills, enabled: false })).status, 403)
      assert.equal((await request('PATCH', '/api/v1/skills/visibility', a.user, { skillName: publishedIds.skills, visible_to: null })).status, 403)
      assert.equal((await request('POST', '/api/v1/skills/uninstall', a.user, { skillName: publishedIds.skills })).status, 403)
      const followup = await ok('POST', '/api/v1/skills/tenant/publish', a.user, { skillId: skill.id })
      assert.equal((await ok('POST', `/api/v1/admin/skills/tenant/${followup.id}/approve`, a.admin, { approved: true })).id, publishedIds.skills, 'The original developer continues the lineage after an administrator revision')
    })
    await t.test('explicit publication versions are suggested, validated, frozen, and replace the stable catalog identity', async () => {
      for (const [kind, segment] of [['skill', 'skills'], ['agent', 'agent-templates']]) {
        const name = `manual-version-${kind}`
        const bytes = await new JSZip().file(kind === 'skill' ? 'SKILL.md' : 'AGENT.md', kind === 'skill' ? `---\nname: ${name}\n---\nVersion test` : 'Version test')
          .file('_moss_meta.json', JSON.stringify({ name, installed_version: '1.0.0', ruleFile: 'AGENT.md' })).generateAsync({ type: 'nodebuffer' })
        const asset = await ok('POST', `/api/v1/${segment}/custom`, a.user, { name, file: bytes.toString('base64') })
        const input = kind === 'skill' ? { skillId: asset.id } : { assistantId: asset.id }
        const previewPath = `/api/v1/${segment}/tenant/publication-preview?id=${asset.id}`
        assert.equal((await ok('GET', previewPath, a.user)).nextVersion, '1.0.0')
        assert.equal((await request('GET', previewPath, b.user)).status, 403)
        assert.equal((await request('POST', `/api/v1/${segment}/tenant/publish`, a.user, { ...input, version: '1.1.0' })).status, 400)
        for (const version of ['v1.0.0', '01.0.0', '1.0', '', null]) {
          assert.notEqual((await request('POST', `/api/v1/${segment}/tenant/publish`, a.user, { ...input, version, publishNote: 'Invalid version' })).status, 200)
        }
        const pending = await ok('POST', `/api/v1/${segment}/tenant/publish`, a.user, { ...input, version: '1.1.0', publishNote: 'First reviewed release' })
        const rows = () => ok('GET', `/api/v1/${segment}/tenant`, a.admin)
        assert.equal((await rows()).find((row: any) => row.id === pending.id).version, '1.1.0')
        assert.equal((await rows()).find((row: any) => row.id === pending.id).publish_note, 'First reviewed release')
        assert.equal((await request('PATCH', `/api/v1/${segment}/tenant/${pending.id}`, a.admin, { version: '9.0.0' })).status, 400)
        await ok('POST', `/api/v1/admin/${segment}/tenant/${pending.id}/approve`, a.admin, { approved: true })
        assert.equal((await request('PATCH', `/api/v1/${segment}/tenant/${pending.id}`, a.admin, { version: '9.0.0' })).status, 400)
        assert.equal((await ok('GET', previewPath, a.user)).nextVersion, '1.1.1')
        for (const version of ['1.1.0', '1.0.9']) assert.equal((await request('POST', `/api/v1/${segment}/tenant/publish`, a.user, { ...input, version, publishNote: 'Cannot reuse/downgrade' })).status, 409)
        const revision = await ok('POST', `/api/v1/${segment}/tenant/publish`, a.user, { ...input, version: '2.0.0', publishNote: 'New major capability' })
        assert.equal((await rows()).find((row: any) => row.id === pending.id).version, '1.1.0', 'Old release remains available during review')
        assert.equal((await ok('POST', `/api/v1/admin/${segment}/tenant/${revision.id}/approve`, a.admin, { approved: true })).id, pending.id)
        const released = (await rows()).find((row: any) => row.id === pending.id)
        assert.equal(released.version, '2.0.0'); assert.equal(released.publish_note, 'New major capability')
        assert.equal((await ok('GET', previewPath, a.user)).nextVersion, '2.0.1')
        const draft = await ok('POST', `/api/v1/catalog/${kind === 'skill' ? 'skills' : 'agents'}/tenant/${pending.id}/draft`, a.admin, {})
        const adminPreview = await ok('GET', `/api/v1/${segment}/tenant/publication-preview?id=${draft.id}`, a.admin)
        assert.equal(adminPreview.nextVersion, '2.0.1')
        await ok('POST', `/api/v1/${segment}/tenant/publish`, a.admin, { ...(kind === 'skill' ? { skillId: draft.id } : { assistantId: draft.id }), version: '3.0.0', publishNote: 'Administrator revision' })
        assert.equal((await rows()).find((row: any) => row.id === draft.id).publish_note, 'Administrator revision')
        await ok('POST', `/api/v1/admin/${segment}/tenant/${draft.id}/approve`, a.admin, { approved: true })
        assert.equal((await ok('GET', previewPath, a.user)).nextVersion, '3.0.1')
      }
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
        await assertExecutableArchive(bytes)
        if (resource.kind === 'agents') {
          assert.match(resource.downloadRef, /\/agent-templates\//)
          assert.match(resource.runtimeRef, /:agents:/)
          const legacyRef = resource.downloadRef.replace('/agent-templates/', '/agents/')
          assert.deepEqual(await ok('GET', legacyRef, a.user), bytes)
          assert.equal((await request('GET', legacyRef, b.user)).status, 404)
        }
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
    await t.test('edits a Hub expert and skill without an installation prerequisite and publishes only after explicit submission', async () => {
      for (const [kind, id, prefix] of [['agents', 'client-agent', 'agent-templates'], ['skills', 'client-skill', 'skills']]) {
        assert.equal((await request('POST', `/api/v1/catalog/${kind}/hub/${id}/draft`, a.user, {})).status, 403)
        const draft = await ok('POST', `/api/v1/catalog/${kind}/hub/${id}/draft`, a.admin, {})
        assert.equal(draft.status, 'draft')
        const again = await ok('POST', `/api/v1/catalog/${kind}/hub/${id}/draft`, a.admin, {})
        assert.equal(again.id, draft.id, 'Opening edit resumes the same owned draft')
        assert.equal((await request('POST', `/api/v1/admin/${prefix}/tenant/${draft.id}/approve`, a.admin, { approved: true })).status, 409)
        await ok('PATCH', `/api/v1/${prefix}/tenant/${draft.id}`, a.admin, { display_name: `Revised ${id}`, ...(kind === 'agents' ? { rules: 'Revised instructions' } : { content: 'Revised skill' }) })
        const privateRows = await ok('GET', `/api/v1/${prefix}/tenant`, a.admin)
        assert.equal(privateRows.find((row: any) => row.id === draft.id).status, 'draft')
        await ok('POST', `/api/v1/${prefix}/tenant/publish`, a.admin, kind === 'agents' ? { assistantId: draft.id } : { skillId: draft.id })
        await ok('POST', `/api/v1/admin/${prefix}/tenant/${draft.id}/approve`, a.admin, { approved: true, visible_to: null })
        const published = (await ok('GET', `/api/v1/${prefix}/tenant?status=approved`, a.admin)).find((row: any) => row.id === draft.id)
        assert.equal(published.replaces_id, id)
        assert.equal(published.display_name, `Revised ${id}`)
        assert.equal(published.isAvailable, true)
        assert.equal((await request('POST', `/api/v1/catalog/${kind}/tenant/${draft.id}/draft`, a.user, {})).status, 403)
        assert.equal((await request('PATCH', `/api/v1/${prefix}/tenant/${draft.id}`, a.user, { display_name: 'forbidden' })).status, 403)
        assert.equal((await request('POST', `/api/v1/catalog/${kind}/tenant/${draft.id}/draft`, b.admin, {})).status, 404)
      }
    })
    await t.test('private/custom resources cannot be read or managed from another organization', async () => {
      const agent = await ok('POST', '/api/v1/agent-templates/tenant/create', a.admin, { name: 'private-agent', display_name: 'Private A', rules: 'A private prompt', visible_to: null })
      const skill = await ok('POST', '/api/v1/skills/tenant/upload', a.admin, { entries: [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: private-skill\ndescription: private\n---\nprivate').toString('base64') }], visible_to: null })
      const custom = await ok('POST', '/api/v1/skills/custom', a.user, { file: skillZip.toString('base64'), name: 'custom-skill', displayName: 'Custom A' })
      assert.equal((await request('GET', `/api/v1/skills/tenant/${skill.id}/content`, a.user)).status, 404)
      assert.equal((await request('GET', `/api/v1/agent-templates/tenant/${agent.data.id}/rules`, a.user)).status, 403)
      await ok('POST', '/api/v1/agent-templates/tenant/publish', a.admin, { assistantId: agent.data.id })
      await ok('POST', '/api/v1/skills/tenant/publish', a.admin, { skillId: skill.id })
      await ok('POST', `/api/v1/admin/agent-templates/tenant/${agent.data.id}/approve`, a.admin, { approved: true })
      await ok('POST', `/api/v1/admin/skills/tenant/${skill.id}/approve`, a.admin, { approved: true })
      assert.match((await ok('GET', `/api/v1/skills/tenant/${skill.id}/content`, a.user)).content, /private/)
      assert.equal((await ok('GET', `/api/v1/agent-templates/tenant/${agent.data.id}/rules`, a.user)).rules, 'A private prompt')
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
      assert.equal((await request('GET', `/api/v1/agent-templates/tenant/${agent.data.id}/rules`, b.admin)).status, 404)
      assert.equal((await request('POST', `/api/v1/admin/agent-templates/tenant/${agent.data.id}/approve`, b.admin, { approved: false })).status, 404)
      assert.equal((await request('PATCH', '/api/v1/agent-templates/meta', b.admin, { assistantName: 'agent-one', updates: { enabledSkills: [skill.id] } })).status, 404)
      await assertExecutableArchive(await ok('GET', `/api/v1/skills/installed/${custom.id}/download`, a.user))
      const beforeTenantInstall = (await ok('GET', '/api/v1/skills/installed', a.user)).length
      await ok('POST', '/api/v1/client/catalog/install', a.user, { kind: 'skills', id: skill.id, source: 'tenant' })
      assert.equal((await ok('GET', '/api/v1/skills/installed', a.user)).length, beforeTenantInstall)
      // Publishing preserves custom originals and does not duplicate their DB ID.
      const publication = await ok('POST', '/api/v1/skills/tenant/publish', a.user, { skillId: custom.id })
      await ok('POST', `/api/v1/admin/skills/tenant/${publication.id}/approve`, a.admin, { approved: true })
      await assertExecutableArchive(await ok('GET', `/api/v1/skills/tenant/${publication.id}/download`, a.admin))
      const revision = await ok('POST', '/api/v1/skills/tenant/publish', a.user, { skillId: custom.id })
      assert.notEqual(revision.id, publication.id)
      assert.equal((await request('POST', '/api/v1/skills/tenant/publish', a.user, { skillId: custom.id })).status, 409)
      const republished = await ok('POST', `/api/v1/admin/skills/tenant/${revision.id}/approve`, a.admin, { approved: true })
      assert.equal(republished.id, publication.id, 'Repeated submission preserves the published catalog ID')
      const visibleVersions = await ok('GET', '/api/v1/skills/tenant?status=approved', a.user)
      assert.equal(visibleVersions.filter((item: any) => item.name === 'custom-skill').length, 1)

      // A same-name private object in B cannot overwrite A's package.
      await ok('POST', '/api/v1/agent-templates/tenant/create', b.admin, { name: 'private-agent', display_name: 'Private B', rules: 'B private prompt' })
      assert.equal((await ok('GET', `/api/v1/agent-templates/tenant/${agent.data.id}/rules`, a.admin)).rules, 'A private prompt')
    })
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
  }
})
