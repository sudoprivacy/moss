import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { findAssistantDir, getAssistantContextSummary, readAssistantMeta } from '../agentStore.js'
import { findInstalledSkillPath, readSkillMeta } from '../skillStore.js'

const maxRuleBytes = 96 * 1024

function validName(name: string) {
  return name.trim().length > 0 && !/[\\/\0]/u.test(name) && name !== '.' && name !== '..'
}

async function readRule(directory: string, filename: string) {
  const root = await realpath(directory)
  const file = await realpath(path.resolve(root, filename))
  if (!file.startsWith(root + path.sep) || (await stat(file)).size > maxRuleBytes) {
    throw new Error('Invalid cabin rule file or rule exceeds size limit')
  }
  const rule = (await readFile(file, 'utf8')).trim()
  if (!rule) throw new Error('Cabin rule file is empty')
  return rule
}

type RuleMode = 'assistant-context' | 'assistant-short'

async function activeRule(directory: string, filename: string, bundledDirectory: string, mode: RuleMode) {
  const source = await readRule(directory, filename)
  if (mode === 'assistant-context') return source
  let reviewed: string
  try {
    reviewed = await readRule(directory, 'CABIN_RULES.md')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    reviewed = await readRule(bundledDirectory, 'CABIN_RULES.md')
  }
  const [header, ...lines] = reviewed.split('\n')
  const text = lines.join('\n').trim()
  const hash = createHash('sha256').update(source).digest('hex')
  if (header !== `source-sha256: ${hash}` || !text) throw new Error(`Review CABIN_RULES.md for ${directory}/${filename} (source-sha256: ${hash})`)
  return text
}

export async function loadCabinAssistantRules(name: string, mode: RuleMode = 'assistant-context') {
  if (!validName(name)) throw new Error('Invalid cabin assistant name')
  const assistant = await findAssistantDir(name)
  if (!assistant) throw new Error(`Cabin assistant is not installed: ${name}`)
  const [meta, summary] = await Promise.all([readAssistantMeta(assistant.dir), getAssistantContextSummary(name)])
  if (meta?.enabled === false || !Array.isArray(meta?.enabledSkills) || !summary?.ruleFile) {
    throw new Error(`Cabin assistant requires active rules and explicit enabledSkills: ${name}`)
  }
  const skills = [...new Set(meta.enabledSkills.map(skill => skill.trim()))]
  const filename = mode === 'assistant-short' ? meta.ruleFile || summary.ruleFile : summary.ruleFile
  if (filename.toLowerCase() === 'cabin_rules.md') throw new Error(`Missing assistant source rules for ${name}`)
  const sections = [await activeRule(assistant.dir, filename, path.resolve('assistants', name), mode)]
  let size = Buffer.byteLength(sections[0]!)
  for (const skill of skills) {
    if (!validName(skill)) throw new Error('Invalid cabin skill name')
    const directory = await findInstalledSkillPath(skill)
    if (!directory || (await readSkillMeta(directory))?.enabled === false) throw new Error(`Cabin skill unavailable: ${skill}`)
    const section = `Skill ${skill}\n${await activeRule(directory, 'SKILL.md', path.resolve('skills/hub', skill), mode)}`
    size += Buffer.byteLength(section) + 2
    if (size > maxRuleBytes) throw new Error('Cabin assistant rules exceed 96 KiB')
    sections.push(section)
  }
  const text = sections.join('\n\n')
  if (mode === 'assistant-short' && size > 6144) throw new Error('Reviewed cabin rules exceed 6 KiB')
  return { text, skills, fingerprint: createHash('sha256').update(text).digest('hex') }
}

export type CabinAssistantRules = Awaited<ReturnType<typeof loadCabinAssistantRules>>

export function cabinRuleCache() {
  let cached: { name: string; until: number; rules: Promise<CabinAssistantRules> } | undefined
  return (name: string, mode: RuleMode = 'assistant-context') => {
    const key = `${mode}:${name}`
    if (cached?.name === key && cached.until > Date.now()) return cached.rules
    const rules = loadCabinAssistantRules(name, mode).catch(error => {
      if (cached?.rules === rules) cached = undefined
      throw error
    })
    cached = { name: key, until: Date.now() + 5000, rules }
    return rules
  }
}
