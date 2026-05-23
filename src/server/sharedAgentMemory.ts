import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import path from 'path'
import * as lockfile from '../utils/lockfile.js'

export type SharedAgentMemoryEntry = {
  content: string
  createdAt: string
  source: 'profile' | 'explicit'
}

const LOCK_OPTIONS = {
  realpath: false,
  retries: {
    retries: 8,
    factor: 1.4,
    minTimeout: 25,
    maxTimeout: 250,
  },
  stale: 10_000,
}

function normalizeMemoryContent(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

export function getSharedAgentMemoryDir(
  configDir: string,
  assistantName: string,
): string {
  return path.join(configDir, '.moss', 'memory', assistantName)
}

export function getSharedAgentMemoryFilePath(
  configDir: string,
  assistantName: string,
): string {
  return path.join(getSharedAgentMemoryDir(configDir, assistantName), 'MEMORY.md')
}

export function getAssistantOverrideAgentsMdPath(configDir: string): string {
  return path.join(configDir, '.nexus', 'sudocode', 'AGENTS.md')
}

export async function readSharedAgentMemory(
  configDir: string,
  assistantName: string,
): Promise<string | null> {
  const filePath = getSharedAgentMemoryFilePath(configDir, assistantName)
  try {
    const content = await readFile(filePath, 'utf8')
    const trimmed = content.trim()
    return trimmed ? trimmed : null
  } catch {
    return null
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  )
  await writeFile(tempPath, content, 'utf8')
  await rename(tempPath, filePath)
}

function parseSharedAgentMemoryEntries(
  content: string,
): SharedAgentMemoryEntry[] {
  const entries: SharedAgentMemoryEntry[] = []
  const normalized = content.replace(/\r\n/g, '\n')
  const headerRegex = /^- \[(profile|explicit)\] ([^\n]+?) \((.*)\)$/gm
  const matches = [...normalized.matchAll(headerRegex)]

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]
    const source = match[1] === 'profile' ? 'profile' : 'explicit'
    const createdAt = match[2]?.trim() || ''
    const title = match[3]?.trim() || ''
    let bodyStart = (match.index ?? 0) + match[0].length
    if (normalized[bodyStart] === '\n') {
      bodyStart += 1
    }
    const bodyEnd = matches[index + 1]?.index ?? normalized.length
    const body = normalized.slice(bodyStart, bodyEnd).trim()
    const combined = [title, body].filter(Boolean).join('\n')
    if (combined) {
      entries.push({
        content: combined,
        createdAt,
        source,
      })
    }
  }

  return entries
}

async function readExistingEntries(
  configDir: string,
  assistantName: string,
): Promise<SharedAgentMemoryEntry[]> {
  const content = await readSharedAgentMemory(configDir, assistantName)
  return content ? parseSharedAgentMemoryEntries(content) : []
}

function formatEntries(entries: SharedAgentMemoryEntry[]): string {
  const lines = [
    '# Shared Agent Memory',
    '',
    'Persistent cross-session memory for this user and assistant.',
    '',
  ]

  for (const entry of entries) {
    const [title, ...rest] = entry.content.split('\n')
    const body = rest.join('\n').trim()
    lines.push(`- [${entry.source}] ${entry.createdAt} (${title.trim()})`)
    if (body) {
      lines.push(body)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}

export async function appendSharedAgentMemory(params: {
  configDir: string
  assistantName: string
  content: string
  source: 'profile' | 'explicit'
}): Promise<boolean> {
  const normalized = normalizeMemoryContent(params.content)
  if (!normalized) {
    return false
  }

  const memoryDir = getSharedAgentMemoryDir(params.configDir, params.assistantName)
  const filePath = getSharedAgentMemoryFilePath(
    params.configDir,
    params.assistantName,
  )
  await mkdir(memoryDir, { recursive: true })

  const release = await lockfile.lock(memoryDir, LOCK_OPTIONS)
  try {
    const entries = await readExistingEntries(params.configDir, params.assistantName)
    const comparable = normalized.toLowerCase()
    if (entries.some(entry => entry.content.toLowerCase() === comparable)) {
      return false
    }

    entries.push({
      content: normalized,
      createdAt: new Date().toISOString(),
      source: params.source,
    })

    await writeFileAtomic(filePath, formatEntries(entries))
    return true
  } finally {
    await release().catch(() => {})
  }
}

export function buildUserProfileMemory(params: {
  userName?: string | null
  role?: string | null
  departmentName?: string | null
  email?: string | null
}): string | null {
  const lines: string[] = []

  if (params.userName) {
    lines.push(`The current logged-in user's name is ${params.userName}. When asked "who am I", answer that the user is ${params.userName} unless corrected.`)
  }
  if (params.role) {
    lines.push(`The user's role is ${params.role}.`)
  }
  if (params.departmentName) {
    lines.push(`The user belongs to the ${params.departmentName} department.`)
  }
  if (params.email) {
    lines.push(`The user's email is ${params.email}.`)
  }

  if (lines.length === 0) {
    return null
  }

  return lines.join('\n')
}

export async function writeAssistantOverrideAgentsMd(params: {
  configDir?: string | null
  assistantName: string
  assistantRules?: string | null
  sharedMemory?: string | null
}): Promise<void> {
  const lines = [
    '# Moss Assistant Override',
    '',
    'These instructions override any default runtime identity or generic assistant framing.',
    '',
    '## Identity Override',
    `When asked "Who are you?" / "你是谁?" you MUST answer: "我是${params.assistantName}，有什么可以帮助你的吗？"`,
    `Your assistant identity is ${params.assistantName}. Do not answer that you are Sudo Code when the user is asking your identity.`,
    '',
  ]

  if (params.sharedMemory?.trim()) {
    lines.push('## Shared User Memory')
    lines.push(
      'Use the following persisted cross-session user memory when the user asks who they are, what their name is, or asks you to recall known preferences. Prefer this memory over guessing from the local environment.',
    )
    lines.push('')
    lines.push(params.sharedMemory.trim())
    lines.push('')
  }

  if (params.assistantRules?.trim()) {
    lines.push('## Assistant Rules')
    lines.push('')
    lines.push(params.assistantRules.trim())
    lines.push('')
  }

  const targets = [
    params.configDir ? getAssistantOverrideAgentsMdPath(params.configDir) : null,
  ].filter((value): value is string => Boolean(value))

  for (const filePath of targets) {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFileAtomic(filePath, `${lines.join('\n').trimEnd()}\n`)
  }
}

export function extractRememberableUserFact(
  text: string,
): { content: string; source: 'explicit' | 'profile' } | null {
  const normalized = text.trim()
  if (!normalized) {
    return null
  }

  const explicitPatterns = [
    /^(?:请)?记住(?:一下)?[:：]?\s*(.+)$/i,
    /^(?:帮我)?记录(?:一下)?[:：]?\s*(.+)$/i,
    /^(?:以后)?别忘了[:：]?\s*(.+)$/i,
    /^(?:请)?保存(?:一下)?[:：]?\s*(.+)$/i,
  ]

  for (const pattern of explicitPatterns) {
    const match = normalized.match(pattern)
    const content = match?.[1]?.trim()
    if (content) {
      return { content, source: 'explicit' }
    }
  }

  const profilePatterns = [
    /^(?:我是|我叫)\s*([^\n]{1,80})$/i,
    /^我希望(?:后续)?对话用(.+)回答$/i,
    /^我希望你(?:以后)?用(.+)回答$/i,
    /^以后请用(.+)回答$/i,
    /^my name is\s+([^\n]{1,80})$/i,
    /^i am\s+([^\n]{1,80})$/i,
  ]

  for (const pattern of profilePatterns) {
    const match = normalized.match(pattern)
    const content = match?.[1]?.trim()
    if (content) {
      return {
        content: normalized,
        source: 'profile',
      }
    }
  }

  return null
}
