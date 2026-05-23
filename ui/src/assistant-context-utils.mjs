import fsp from 'node:fs/promises';
import path from 'node:path';

export const ASSISTANT_META_FILE = '_moss_meta.json';

const COMMON_RULE_FILE_NAMES = [
  'system.md',
  'prompt.md',
  'assistant.md',
  'instructions.md',
  'rules.md',
];

const DOCUMENTATION_MARKDOWN_PATTERNS = [
  /^readme(?:\.[^.]+)?$/i,
  /^changelog(?:\.[^.]+)?$/i,
  /^license(?:\.[^.]+)?$/i,
  /^contributing(?:\.[^.]+)?$/i,
];

function normalizeAssistantRelativePath(filePath) {
  if (typeof filePath !== 'string') return '';
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized) return '';
  if (/^[a-zA-Z]:\//.test(normalized)) return '';
  if (normalized.startsWith('/')) return '';

  const safePath = path.posix.normalize(normalized);
  if (safePath === '.' || safePath === '..' || safePath.startsWith('../')) return '';
  return safePath;
}

function isDocumentationMarkdownFile(fileName) {
  return DOCUMENTATION_MARKDOWN_PATTERNS.some((pattern) => pattern.test(fileName));
}

async function fileExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function readAssistantMeta(assistantDir) {
  try {
    const metaContent = await fsp.readFile(path.join(assistantDir, ASSISTANT_META_FILE), 'utf-8');
    return JSON.parse(metaContent);
  } catch {
    return null;
  }
}

export async function findAssistantDirByName(assistantName, searchDirs) {
  const normalizedAssistantName = String(assistantName || '').trim();
  if (!normalizedAssistantName) {
    return null;
  }

  const directories = searchDirs
    .map((entry) => (typeof entry === 'string' ? entry : entry?.dir))
    .filter(Boolean);

  const candidateNames = [normalizedAssistantName];
  if (normalizedAssistantName.startsWith('builtin-')) {
    candidateNames.push(normalizedAssistantName.slice('builtin-'.length));
  }

  for (const dir of directories) {
    for (const candidateName of candidateNames) {
      const assistantDir = path.join(dir, candidateName);
      try {
        const stat = await fsp.stat(assistantDir);
        if (stat.isDirectory()) {
          return assistantDir;
        }
      } catch {
        // Continue searching.
      }
    }
  }

  for (const dir of directories) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const candidateDir = path.join(dir, entry.name);
        const meta = await readAssistantMeta(candidateDir);
        if (meta?.name === normalizedAssistantName) {
          return candidateDir;
        }
      }
    } catch {
      // Ignore missing or unreadable directories.
    }
  }

  return null;
}

export function getAssistantEnabledSkillIdentifiers(meta) {
  if (Array.isArray(meta?.enabledSkills) && meta.enabledSkills.length > 0) {
    return meta.enabledSkills;
  }
  return Array.isArray(meta?.skills) ? meta.skills : [];
}

export async function resolveAssistantRuleFile(assistantDir, assistantName, preferredRuleFile) {
  const candidateFiles = [];
  const seenCandidates = new Set();

  const addCandidate = (candidate) => {
    const normalized = normalizeAssistantRelativePath(candidate);
    if (!normalized) return;
    const lookupKey = normalized.toLowerCase();
    if (seenCandidates.has(lookupKey)) return;
    seenCandidates.add(lookupKey);
    candidateFiles.push(normalized);
  };

  addCandidate(preferredRuleFile);
  if (assistantName) {
    addCandidate(`${assistantName}.md`);
  }
  for (const candidate of COMMON_RULE_FILE_NAMES) {
    addCandidate(candidate);
  }

  for (const candidate of candidateFiles) {
    if (!candidate.toLowerCase().endsWith('.md')) continue;
    const fullPath = path.resolve(assistantDir, candidate);
    if (await fileExists(fullPath)) {
      return candidate;
    }
  }

  let markdownFiles = [];
  try {
    const entries = await fsp.readdir(assistantDir, { withFileTypes: true });
    markdownFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }

  const nonDocumentationMarkdownFiles = markdownFiles.filter(
    (fileName) => !isDocumentationMarkdownFile(fileName),
  );

  if (nonDocumentationMarkdownFiles.length === 1) {
    return nonDocumentationMarkdownFiles[0];
  }

  return undefined;
}

export async function readAssistantContext(assistantDir, assistantName) {
  const meta = await readAssistantMeta(assistantDir);
  const ruleFile = await resolveAssistantRuleFile(assistantDir, assistantName, meta?.ruleFile);

  let rules = '';
  if (ruleFile) {
    try {
      rules = await fsp.readFile(path.resolve(assistantDir, ruleFile), 'utf-8');
    } catch {
      rules = '';
    }
  }

  return {
    meta,
    ruleFile,
    rules,
    enabledSkillIdentifiers: getAssistantEnabledSkillIdentifiers(meta),
  };
}

export function buildInstalledSkillLookup(installedSkills = []) {
  const lookup = new Map();

  for (const skill of installedSkills) {
    if (!skill || !skill.source) continue;

    const keys = [
      skill.id,
      skill.name,
      path.basename(skill.source),
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    for (const key of keys) {
      if (!lookup.has(key)) {
        lookup.set(key, skill);
      }
    }
  }

  return lookup;
}

export function resolveInstalledSkillInfos(identifiers = [], installedSkills = []) {
  const lookup = buildInstalledSkillLookup(installedSkills);
  const resolvedSkills = [];
  const seenSources = new Set();

  for (const identifier of identifiers) {
    const skill = lookup.get(String(identifier || '').trim());
    if (!skill?.source || seenSources.has(skill.source)) continue;
    seenSources.add(skill.source);
    resolvedSkills.push({
      name: skill.name || path.basename(skill.source),
      path: skill.source,
    });
  }

  return resolvedSkills;
}
