import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SystemSettings } from '../lib/api/types'
import { buildSystemSettingsPatch, createSettingsDraft, FIELD_LABELS, getRedactedSettings, getSettingsChanges, MIB, TAB_FIELDS, validateSettingsDraft as validateDraft } from '../lib/system-settings'

const validateSettingsDraft = (draft: Parameters<typeof validateDraft>[0]) => validateDraft(draft, 'platform')

const settings: SystemSettings = {
  scopeType: 'platform', organizationId: '',
  model: 'test-model', url: '', apiKey: '', apiKeyConfigured: true,
  image: { provider: 'openai', url: '', apiKey: '', apiKeyConfigured: true, model: 'test-image' },
  bypassPermissions: false, maxTurns: 100, thinkingMode: 'adaptive', thinkingBudgetTokens: 16000,
  skillStore: { tenantId: '' }, oauth2: { enabled: false, requireState: true, authorizeUrlTemplate: '', scriptPath: '/opt/oauth.sh' },
  clientCronEnabled: true, clientShowToolCalls: true, workspaceUploadLimitBytes: 20 * MIB + 7,
  cronReuseMaxRuns: 50, imReuseMaxTurns: 200, mintScriptsDir: '/opt/scripts',
  settingsPath: '/fixture/settings.json', settingsExists: true, settingsLoaded: true, settingsParseError: '',
}

const fresh = () => createSettingsDraft(settings)

test('unchanged draft is valid and produces no patch or changes, including exact byte limit', () => {
  assert.deepEqual(validateSettingsDraft(fresh()), {})
  assert.deepEqual(buildSystemSettingsPatch(settings, fresh()), {})
  assert.deepEqual(getSettingsChanges(settings, fresh()), [])
  assert.equal(Number(fresh().uploadLimitMiB) * MIB, settings.workspaceUploadLimitBytes)
})

test('malformed server configuration cannot be rewritten by the form', () => {
  assert.throws(() => buildSystemSettingsPatch({ ...settings, settingsParseError: 'Invalid JSON' }, { ...fresh(), model: 'next' }), /修复/)
})

test('all editable fields are categorized exactly once', () => {
  const fields = Object.values(TAB_FIELDS).flat().sort()
  assert.equal(fields.length, 22)
  assert.equal(new Set(fields).size, fields.length)
  assert.deepEqual(fields, Object.keys(FIELD_LABELS).sort())
  assert.deepEqual(fields, Object.keys(fresh()).sort())
})

test('every editable field reaches the API without including read-only paths or metadata', () => {
  const draft = { ...fresh(), model: 'next', url: 'https://text.example.invalid', apiKey: { action: 'replace' as const, value: 'new-text' }, imageProvider: 'google', imageUrl: 'https://image.example.invalid', imageModel: 'next-image', imageApiKey: { action: 'replace' as const, value: 'new-image' }, tenantId: 'next-tenant', bypassPermissions: true, maxTurns: '10', cronReuseMaxRuns: '0', imReuseMaxTurns: '0', thinkingMode: 'enabled' as const, thinkingBudgetTokens: '1024', clientCronEnabled: false, clientShowToolCalls: false, uploadLimitMiB: '100', oauthEnabled: true, oauthRequireState: false, authorizeUrlTemplate: 'https://idp.example.invalid/auth?redirect_uri={redirect_uri}&state={state}' }
  assert.deepEqual(buildSystemSettingsPatch(settings, draft), {
    model: 'next', url: 'https://text.example.invalid', apiKey: 'new-text',
    image: { provider: 'google', url: 'https://image.example.invalid', model: 'next-image', apiKey: 'new-image' },
    skillStore: { tenantId: 'next-tenant' }, bypassPermissions: true, maxTurns: 10, cronReuseMaxRuns: 0, imReuseMaxTurns: 0,
    thinkingMode: 'enabled', thinkingBudgetTokens: 1024, clientCronEnabled: false, clientShowToolCalls: false, workspaceUploadLimitBytes: 100 * MIB,
    oauth2: { enabled: true, requireState: false, authorizeUrlTemplate: draft.authorizeUrlTemplate },
  })
  assert.equal(getSettingsChanges(settings, draft).length, 20)
})

test('single-field and nested updates stay minimal', () => {
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), model: 'next' }), { model: 'next' })
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), imageModel: 'next' }), { image: { model: 'next' } })
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), oauthRequireState: false }), { oauth2: { requireState: false } })
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), clientCronEnabled: false }), { clientCronEnabled: false })
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), clientShowToolCalls: false }), { clientShowToolCalls: false })
})

test('secrets default to keep without hydrating raw values; replace and clear are explicit', () => {
  assert.deepEqual(fresh().apiKey, { action: 'keep', value: '' })
  assert.deepEqual(fresh().imageApiKey, { action: 'keep', value: '' })
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), apiKey: { action: 'keep', value: 'ignored' } }), {})
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), apiKey: { action: 'replace', value: '  new-key  ' } }), { apiKey: 'new-key' })
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), imageApiKey: { action: 'clear', value: 'ignored' } }), { image: { apiKey: '' } })
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), apiKey: { action: 'clear', value: '' } }), { apiKey: '' })
  assert.ok(validateSettingsDraft({ ...fresh(), apiKey: { action: 'replace', value: '  ' } }).apiKey)
  assert.throws(() => buildSystemSettingsPatch(settings, { ...fresh(), imageApiKey: { action: 'replace', value: '' } }))
})

test('review and saved configuration never serialize secret contents', () => {
  const text = JSON.stringify(getSettingsChanges(settings, { ...fresh(), apiKey: { action: 'replace', value: 'replacement-secret' } }))
  assert.ok(!text.includes('replacement-secret'))
  const redacted = JSON.stringify(getRedactedSettings(settings))
  assert.ok(redacted.includes('[已配置，已隐藏]'))
  assert.equal(settings.apiKey, '')
})

test('whole-byte uploads from one byte through one GiB round-trip without mutation', () => {
  for (const bytes of [1, 2, MIB - 1, MIB + 1, 20 * MIB + 7, 1024 * MIB]) {
    const baseline = { ...settings, workspaceUploadLimitBytes: bytes }
    const draft = createSettingsDraft(baseline)
    assert.deepEqual(validateSettingsDraft(draft), {})
    assert.deepEqual(buildSystemSettingsPatch(baseline, draft), {})
  }
  for (const value of ['', '0', '-1', '1025', 'NaN', 'Infinity', '0.0000001']) {
    assert.ok(validateSettingsDraft({ ...fresh(), uploadLimitMiB: value }).uploadLimitMiB, value)
  }
  assert.deepEqual(buildSystemSettingsPatch(settings, { ...fresh(), uploadLimitMiB: '0.5' }), { workspaceUploadLimitBytes: MIB / 2 })
})

test('numeric drafts accept bounded integers and reject blank, fractional and out-of-range input', () => {
  for (const [field, min, max] of [['maxTurns', 1, 10000], ['cronReuseMaxRuns', 0, 10000], ['imReuseMaxTurns', 0, 10000], ['thinkingBudgetTokens', 1024, 128000]] as const) {
    for (const value of [String(min), String(max)]) assert.equal(validateSettingsDraft({ ...fresh(), thinkingMode: 'enabled', [field]: value })[field], undefined)
    for (const value of ['', '1.5', String(min - 1), String(max + 1), 'NaN']) assert.ok(validateSettingsDraft({ ...fresh(), thinkingMode: 'enabled', [field]: value })[field], `${field}: ${value}`)
  }
})

test('unfinished hidden thinking budget is neither submitted nor marked as a change', () => {
  const draft = { ...fresh(), thinkingBudgetTokens: '', maxTurns: '5' }
  assert.deepEqual(validateSettingsDraft(draft), {})
  assert.deepEqual(buildSystemSettingsPatch(settings, draft), { maxTurns: 5 })
  assert.deepEqual(getSettingsChanges(settings, draft).map(change => change.field), ['maxTurns'])
})

test('URL validation permits blank defaults and OAuth placeholders but rejects unsafe protocols', () => {
  for (const field of ['url', 'imageUrl', 'authorizeUrlTemplate'] as const) {
    for (const value of ['javascript:alert(1)', 'not a url', 'ftp://example.invalid']) assert.ok(validateSettingsDraft({ ...fresh(), [field]: value })[field])
  }
  assert.ok(validateSettingsDraft({ ...fresh(), oauthEnabled: true }).authorizeUrlTemplate)
  assert.deepEqual(validateSettingsDraft({ ...fresh(), oauthEnabled: true, authorizeUrlTemplate: 'https://idp.example.invalid?redirect_uri={redirect_uri}&state={state}' }), {})
  assert.ok(validateSettingsDraft({ ...fresh(), model: '  ' }).model)
})

test('organization model edits ignore hidden invalid deployment fields and never submit them', () => {
  const organizationSettings = { ...settings, scopeType: 'organization' as const, organizationId: 'org-a' }
  const draft = {
    ...fresh(), model: 'org-model', imageModel: 'org-image',
    tenantId: 'forbidden', bypassPermissions: true, maxTurns: '', cronReuseMaxRuns: '-1',
    imReuseMaxTurns: '', thinkingMode: 'enabled' as const, thinkingBudgetTokens: '',
    clientCronEnabled: false, clientShowToolCalls: false, uploadLimitMiB: '',
    oauthEnabled: true, oauthRequireState: false, authorizeUrlTemplate: 'invalid',
  }
  assert.deepEqual(validateDraft(draft, 'organization'), {})
  assert.deepEqual(validateDraft(draft), {})
  assert.deepEqual(buildSystemSettingsPatch(organizationSettings, draft), { model: 'org-model', image: { model: 'org-image' } })
  assert.deepEqual(getSettingsChanges(organizationSettings, draft).map(change => change.field), ['model', 'imageModel'])
  assert.throws(() => buildSystemSettingsPatch(settings, draft, 'platform'))
  assert.deepEqual(buildSystemSettingsPatch({ ...settings, scopeType: undefined }, draft), { model: 'org-model', image: { model: 'org-image' } })
})

test('organization scope still validates and submits provider and secret changes', () => {
  const provider = {
    id: 'org-provider', name: 'Organization provider', kind: 'openai-compatible' as const,
    baseUrl: 'https://model.example.invalid/v1', discoveryUrl: 'https://model.example.invalid/v1/models',
    protocol: 'openai-completions' as const, enabled: true, apiKeyConfigured: true,
  }
  const baseline = { ...settings, scopeType: 'organization' as const, organizationId: 'org-a', modelProviders: [provider], defaultModelProviderId: provider.id }
  const draft = { ...createSettingsDraft(baseline), modelProviders: [{ ...provider, apiKey: ' new-provider-key ' }], imageApiKey: { action: 'clear' as const, value: '' } }
  const { apiKeyConfigured: _, ...metadata } = provider
  assert.deepEqual(buildSystemSettingsPatch(baseline, draft), { modelProviders: [{ ...metadata, apiKey: 'new-provider-key' }], image: { apiKey: '' } })
  assert.ok(validateDraft({ ...draft, imageUrl: 'javascript:alert(1)' }).imageUrl)
  assert.ok(validateDraft({ ...draft, modelProviders: [{ ...provider, baseUrl: 'invalid' }] }).modelProviders)
})
