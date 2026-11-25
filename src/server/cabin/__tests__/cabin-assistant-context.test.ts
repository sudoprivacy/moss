import { expect, it } from 'bun:test'
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('uses the installed rules in seat chat and dispatches the suggested action only on confirmation', async () => {
  const root = resolve(import.meta.dir, '../../../..')
  const fixture = await mkdtemp(join(tmpdir(), 'cabin-installed-rules-'))
  const requests: Array<{ messages: Array<{ content: string }> }> = []
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/tts') return new Response('mock-speech', { headers: {
      'content-type': 'audio/wav', 'x-cabin-tts-deterministic': 'seeded-serial-v1', 'x-cabin-tts-seed': '42',
    } })
    const body = await request.json()
    requests.push(body)
    const text = body.messages.at(-1).content as string
    const choice = text.includes('眯一会儿') ? ['cabin_offer', { action: 'recline' }]
      : text.includes('座椅角度') ? ['cabin_status', { target_type: 'seat', status_key: 'posture' }]
      : text.includes('办公模式') ? ['cabin_mode', { mode: 'office' }] : undefined
    const message = choice ? { tool_calls: [{ id: 'test', type: 'function', function: { name: choice[0], arguments: JSON.stringify(choice[1]) } }] } : { content: text.includes('腰背有点僵') ? '需要我为您开启座椅按摩功能吗？' : '我可以为您介绍客舱服务。' }
    return Response.json({ choices: [{ finish_reason: choice ? 'tool_calls' : 'stop', message }] })
  } })
  try {
    const name = 'cabin-ai-flight-attendant'
    await mkdir(join(fixture, 'assistants/system'), { recursive: true })
    await cp(join(root, 'assistants', name), join(fixture, 'assistants/system', name), { recursive: true })
    await mkdir(join(fixture, 'skills/hub'), { recursive: true })
    for (const skill of ['cabin-hardware-control', 'cabin-hardware-status-query', 'cabin-mode-switch']) {
      await cp(join(root, 'skills/hub', skill), join(fixture, 'skills/hub', skill), { recursive: true })
    }
    const smoke = async (mode: string, prewarm = false) => {
      const run = Bun.spawn([process.execPath, 'scripts/cabin-live-smoke.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, MOSS_HOME: fixture, CABIN_ASSISTANT_NAME: name, CABIN_SMOKE_DIALOGUE_MODE: mode, CABIN_SMOKE_PREWARM: prewarm ? '1' : '0', CABIN_SMOKE_MASKED_NAME: '0',
        CABIN_SMOKE_LLM_URL: `http://127.0.0.1:${model.port}/v1`, CABIN_SMOKE_LLM_MODEL: 'test', CABIN_SMOKE_TTS_MODEL: 'test', CABIN_SMOKE_TTS_URL: `http://127.0.0.1:${model.port}/tts`,
      } })
      const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
      if (code !== 0) throw new Error(stderr)
      return JSON.parse(stdout.slice(stdout.indexOf('{\n  "dialogue_mode"'))).outcomes
    }
    const outcomes = await smoke('assistant-context')
    expect(outcomes.at(-2).mock_device_calls).toBe(0)
    expect(outcomes.at(-1).mock_device_calls).toBe(1)
    const request = requests.find(body => body.messages.at(-1)?.content.includes('眯一会儿'))!
    for (const skill of ['cabin-hardware-control', 'cabin-hardware-status-query', 'cabin-mode-switch']) expect(request.messages[0]!.content).toContain(`Skill ${skill}\n`)
    expect(request.messages[0]!.content).toContain('受过训练的客舱乘务员')
    expect(request.messages[1]!.content).toContain('林女士')
    expect(JSON.stringify(request)).not.toContain('local-smoke-only')
    requests.length = 0
    await smoke('assistant-short', true)
    expect(requests[0]?.messages.at(-1)?.content).toBe('请介绍客舱服务。')
    const shortRequest = requests.find(body => body.messages.at(-1)?.content.includes('眯一会儿'))!
    expect(shortRequest.messages[1]!.content).toContain('林女士')
    expect(shortRequest.messages[0]!.content.length).toBeLessThan(request.messages[0]!.content.length)
    const source = join(fixture, 'skills/hub/cabin-hardware-control/SKILL.md')
    await appendFile(source, '\n修改后的规则')
    await expect(smoke('assistant-short')).rejects.toThrow('Review CABIN_RULES.md')
    await rm(source)
    await expect(smoke('assistant-short')).rejects.toThrow('SKILL.md')
  } finally {
    model.stop(true)
    await rm(fixture, { recursive: true, force: true })
  }
}, 15000)
