import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import {
  appendSharedAgentMemory,
  buildUserProfileMemory,
  extractRememberableUserFact,
  getAssistantOverrideAgentsMdPath,
  readSharedAgentMemory,
  writeAssistantOverrideAgentsMd,
} from '../sharedAgentMemory.js'
import { runtimeInfoSchema } from '../types.js'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'moss-shared-memory-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('shared agent memory', () => {
  it('preserves existing entries when appending another memory', async () => {
    await withTempDir(async configDir => {
      expect(
        await appendSharedAgentMemory({
          configDir,
          assistantName: 'helper',
          content: 'first fact\nwith detail',
          source: 'explicit',
        }),
      ).toBe(true)
      expect(
        await appendSharedAgentMemory({
          configDir,
          assistantName: 'helper',
          content: 'second fact',
          source: 'profile',
        }),
      ).toBe(true)

      const memory = await readSharedAgentMemory(configDir, 'helper')
      expect(memory).toContain('first fact')
      expect(memory).toContain('with detail')
      expect(memory).toContain('second fact')
    })
  })

  it('deduplicates normalized memory content', async () => {
    await withTempDir(async configDir => {
      expect(
        await appendSharedAgentMemory({
          configDir,
          assistantName: 'helper',
          content: 'Remember this',
          source: 'explicit',
        }),
      ).toBe(true)
      expect(
        await appendSharedAgentMemory({
          configDir,
          assistantName: 'helper',
          content: ' remember this ',
          source: 'explicit',
        }),
      ).toBe(false)

      const memory = await readSharedAgentMemory(configDir, 'helper')
      expect(memory?.match(/Remember this/gi)?.length).toBe(1)
    })
  })

  it('serializes concurrent appends to the same user memory file', async () => {
    await withTempDir(async configDir => {
      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          appendSharedAgentMemory({
            configDir,
            assistantName: 'helper',
            content: `fact ${index}`,
            source: 'explicit',
          }),
        ),
      )

      const memory = await readSharedAgentMemory(configDir, 'helper')
      for (let index = 0; index < 5; index++) {
        expect(memory).toContain(`fact ${index}`)
      }
    })
  })

  it('builds profile memory and extracts explicit user facts', () => {
    expect(
      buildUserProfileMemory({
        userName: 'Alice',
        role: 'admin',
        departmentName: 'Platform',
        email: 'alice@example.com',
      }),
    ).toContain("The current logged-in user's name is Alice.")

    expect(extractRememberableUserFact('请记住：我喜欢中文回答')).toEqual({
      content: '我喜欢中文回答',
      source: 'explicit',
    })
    expect(extractRememberableUserFact('我叫 Alice')).toEqual({
      content: '我叫 Alice',
      source: 'profile',
    })
  })

  it('writes assistant override only under the runtime config directory', async () => {
    await withTempDir(async configDir => {
      await writeAssistantOverrideAgentsMd({
        configDir,
        assistantName: 'helper',
        assistantRules: 'Always answer tersely.',
        sharedMemory: 'User prefers Chinese.',
      })

      const override = await readFile(
        getAssistantOverrideAgentsMdPath(configDir),
        'utf8',
      )
      expect(override).toContain('我是helper')
      expect(override).toContain('User prefers Chinese.')
      expect(override).toContain('Always answer tersely.')
    })
  })
})

describe('runtime schema', () => {
  it('preserves hostMode in runtime info responses', () => {
    const parsed = runtimeInfoSchema().parse({
      type: 'host',
      engine: 'scode',
      hostMode: 'user',
      configDir: '/tmp/moss-user-config',
    })
    expect(parsed.hostMode).toBe('user')
  })
})
