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

export async function loadCabinAssistantRules(name: string) {
  if (!validName(name)) throw new Error('Invalid cabin assistant name')
  const assistant = await findAssistantDir(name)
  if (!assistant) throw new Error(`Cabin assistant is not installed: ${name}`)
  const [meta, summary] = await Promise.all([readAssistantMeta(assistant.dir), getAssistantContextSummary(name)])
  if (meta?.enabled === false || !Array.isArray(meta?.enabledSkills) || !summary?.ruleFile) {
    throw new Error(`Cabin assistant requires active rules and explicit enabledSkills: ${name}`)
  }
  const skills = [...new Set(meta.enabledSkills.map(skill => skill.trim()))]
  const sections = [await readRule(assistant.dir, summary.ruleFile)]
  let size = Buffer.byteLength(sections[0]!)
  for (const skill of skills) {
    if (!validName(skill)) throw new Error('Invalid cabin skill name')
    const directory = await findInstalledSkillPath(skill)
    if (!directory || (await readSkillMeta(directory))?.enabled === false) throw new Error(`Cabin skill unavailable: ${skill}`)
    const section = `Skill ${skill}\n${await readRule(directory, 'SKILL.md')}`
    size += Buffer.byteLength(section) + 2
    if (size > maxRuleBytes) throw new Error('Cabin assistant rules exceed 96 KiB')
    sections.push(section)
  }
  const text = sections.join('\n\n')
  return { text, skills, fingerprint: createHash('sha256').update(text).digest('hex') }
}

export type CabinAssistantRules = Awaited<ReturnType<typeof loadCabinAssistantRules>>

export function cabinRuleCache() {
  let cached: { name: string; until: number; rules: Promise<CabinAssistantRules> } | undefined
  return (name: string) => {
    if (cached?.name === name && cached.until > Date.now()) return cached.rules
    const rules = loadCabinAssistantRules(name).catch(error => {
      if (cached?.rules === rules) cached = undefined
      throw error
    })
    cached = { name, until: Date.now() + 5000, rules }
    return rules
  }
}
