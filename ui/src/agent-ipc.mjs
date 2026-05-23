import electron from 'electron';
const { ipcMain } = electron;
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import {
  ASSISTANT_META_FILE,
  buildInstalledSkillLookup,
  findAssistantDirByName,
  readAssistantContext,
  resolveAssistantRuleFile,
  resolveInstalledSkillInfos,
} from './assistant-context-utils.mjs';
import { downloadFileBuffer } from './download-utils.mjs';
import {
  ASSISTANT_HUB_BASE_URL,
  ASSISTANT_HUB_CURSOR_URL,
  HUB_AUTHORIZATION,
  HUB_CATEGORIES_URL,
  SKILL_HUB_BASE_URL,
} from './hub-config.mjs';
import { getInstalledSkills, installSkillFromZip } from './skill-store-ipc.mjs';

const MOSS_HOME = path.join(os.homedir(), '.moss');
const MOSS_ASSISTANTS_DIR = path.join(MOSS_HOME, 'assistants');
const ASSISTANT_HUB_DIR = path.join(MOSS_ASSISTANTS_DIR, 'hub');
const ASSISTANT_SYSTEM_DIR = path.join(MOSS_ASSISTANTS_DIR, 'system');
const ASSISTANT_CUSTOM_DIR = path.join(MOSS_ASSISTANTS_DIR, '_my-custom-assistant');
const ASSISTANT_SEARCH_DIRS = [ASSISTANT_CUSTOM_DIR, ASSISTANT_HUB_DIR, ASSISTANT_SYSTEM_DIR];

async function verifyChecksum(buffer, expectedChecksum) {
  const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
  return actualChecksum === expectedChecksum;
}

function isUnsafeZipEntryPath(entryPath) {
  if (!entryPath || entryPath === '.') return false;
  if (/^[a-zA-Z]:[\\/]/.test(entryPath)) return true;
  if (entryPath.startsWith('/') || entryPath.startsWith('\\')) return true;
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalized === '..' || normalized.startsWith('../');
}

function normalizeZipEntryPath(entryPath) {
  return path.posix.normalize(entryPath.replaceAll('\\', '/').replace(/^\.\/+/, ''));
}

function resolveZipAssistantLayout(zip) {
  const fileEntries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => normalizeZipEntryPath(entry.name))
    .filter((entryPath) => !entryPath.includes('__MACOSX') && !entryPath.endsWith('.DS_Store'))
    .filter(Boolean);

  for (const entryPath of fileEntries) {
    if (isUnsafeZipEntryPath(entryPath)) {
      throw new Error(`Unsafe zip entry path: ${entryPath}`);
    }
  }

  const topLevelParts = fileEntries.map((entryPath) => entryPath.split('/')[0]);
  const uniqueTopLevel = Array.from(new Set(topLevelParts));

  if (uniqueTopLevel.length === 1 && fileEntries.every((e) => e.includes('/'))) {
    return { stripPrefix: `${uniqueTopLevel[0]}/` };
  }

  return { stripPrefix: '' };
}

async function extractAssistantZip(buffer, targetDir) {
  const zip = await JSZip.loadAsync(buffer);
  const { stripPrefix } = resolveZipAssistantLayout(zip);

  await fsp.mkdir(targetDir, { recursive: true });

  for (const zipEntry of Object.values(zip.files)) {
    if (zipEntry.dir) continue;
    if (isUnsafeZipEntryPath(zipEntry.name)) {
      throw new Error(`Unsafe zip entry path: ${zipEntry.name}`);
    }

    const normalizedPath = normalizeZipEntryPath(zipEntry.name);
    if (normalizedPath.includes('__MACOSX') || normalizedPath.endsWith('.DS_Store')) continue;

    let targetPath = normalizedPath;

    if (stripPrefix) {
      if (!normalizedPath.startsWith(stripPrefix)) continue;
      targetPath = normalizedPath.slice(stripPrefix.length);
    }

    if (!targetPath) continue;

    const fullPath = path.join(targetDir, targetPath);
    const fullDir = path.dirname(fullPath);
    await fsp.mkdir(fullDir, { recursive: true });

    const content = await zipEntry.async('nodebuffer');
    await fsp.writeFile(fullPath, content);
  }
}

async function scanAssistantDirs(baseDir) {
  const dirs = [];
  try {
    await fsp.access(baseDir);
  } catch {
    return dirs;
  }
  const entries = await fsp.readdir(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    dirs.push(path.join(baseDir, entry.name));
  }
  return dirs;
}

function findAssistantDir(name) {
  const searchDirs = [
    { dir: ASSISTANT_CUSTOM_DIR, category: 'custom' },
    { dir: ASSISTANT_HUB_DIR, category: 'hub' },
    { dir: ASSISTANT_SYSTEM_DIR, category: 'system' },
  ];

  for (const { dir, category } of searchDirs) {
    const assistantDir = path.join(dir, name);
    try {
      fs.accessSync(assistantDir);
      return { dir: assistantDir, category };
    } catch {
      // Not found in this directory
    }
  }

  // Try stripping 'builtin-' prefix for system dir lookup
  if (name.startsWith('builtin-')) {
    const stripped = name.slice('builtin-'.length);
    const systemPath = path.join(ASSISTANT_SYSTEM_DIR, stripped);
    try {
      fs.accessSync(systemPath);
      return { dir: systemPath, category: 'system' };
    } catch {
      // Not found
    }
  }

  // Fallback: scan assistant metadata and match by logical meta.name.
  for (const { dir, category } of searchDirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const assistantDir = path.join(dir, entry.name);
        const metaPath = path.join(assistantDir, ASSISTANT_META_FILE);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta?.name === name) {
            return { dir: assistantDir, category };
          }
        } catch {
          // Ignore invalid meta and continue scanning.
        }
      }
    } catch {
      // Ignore missing directory and continue scanning.
    }
  }

  return null;
}

async function getInstalledAssistants() {
  const assistants = [];

  for (const baseDir of [ASSISTANT_SYSTEM_DIR, ASSISTANT_HUB_DIR, ASSISTANT_CUSTOM_DIR]) {
    const dirs = await scanAssistantDirs(baseDir);
    for (const assistantDir of dirs) {
      const dirName = path.basename(assistantDir);
      let category = 'custom';
      if (assistantDir.startsWith(ASSISTANT_SYSTEM_DIR)) category = 'system';
      else if (assistantDir.startsWith(ASSISTANT_HUB_DIR)) category = 'hub';

      const metaPath = path.join(assistantDir, ASSISTANT_META_FILE);
      try {
        const metaContent = await fsp.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaContent);
        assistants.push({
          name: meta.name || dirName,
          displayName: meta.display_name || meta.name || dirName,
          description: meta.description || '',
          avatar: meta.avatar || '',
          emoji: meta.emoji || '',
          category: meta.category || '',
          categories: meta.categories || [],
          version: meta.installed_version || '',
          source: assistantDir,
          isBuiltin: meta.is_builtin === true,
          isHubInstalled: meta.source_type === 'hub',
          tag: meta.tag || category,
          enabled: meta.enabled !== false,
          skills: meta.skills || [],
          enabledSkills: meta.enabledSkills || [],
        });
      } catch {
        assistants.push({
          name: dirName,
          displayName: dirName,
          description: '',
          avatar: '',
          emoji: '',
          category: '',
          categories: [],
          version: '',
          source: assistantDir,
          isBuiltin: false,
          isHubInstalled: category === 'hub',
          tag: category,
          enabled: true,
          skills: [],
          enabledSkills: [],
        });
      }
    }
  }

  return assistants;
}

export function registerAgentIpcHandlers() {
  // Fetch assistants from Hub with pagination
  ipcMain.handle('agent:fetchAssistants', async (_event, { cursor, limit = 20, query = '', category = '' } = {}) => {
    try {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      if (query) params.set('query', query);
      if (category) params.set('category', category);

      const url = `${ASSISTANT_HUB_CURSOR_URL}?${params}`;

      const response = await fetch(url, {
        headers: { Authorization: HUB_AUTHORIZATION },
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const result = await response.json();

      if (result.success && result.data) {
        const rawAssistants = result.data.assistants || [];
        const assistants = rawAssistants.map((a) => ({
          id: a.id,
          name: a.name,
          display_name: a.profession || a.name,
          description: a.description || '',
          avatar: a.avatar || '',
          emoji: null,
          categories: a.categories || [],
          category: (a.categories || [])[0] || '',
          _sourceUrl: a.sourceUrl || '',
        }));

        return {
          success: true,
          data: {
            assistants,
            next_cursor: result.data.next_cursor || null,
            has_more: result.data.has_more || false,
          },
        };
      }
      return { success: false, error: result.message || 'Failed to fetch assistants' };
    } catch (err) {
      console.error('[AgentStore] Fetch error:', err);
      return { success: false, error: err.message };
    }
  });

  // Fetch categories
  ipcMain.handle('agent:fetchCategories', async () => {
    try {
      const response = await fetch(`${HUB_CATEGORIES_URL}?type=1`, {
        headers: { Authorization: HUB_AUTHORIZATION },
      });
      const result = await response.json();
      return { success: true, data: result.data || [] };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Fetch assistant detail
  ipcMain.handle('agent:fetchAssistantDetail', async (_event, { assistantId }) => {
    try {
      const response = await fetch(`${ASSISTANT_HUB_BASE_URL}/${assistantId}`, {
        headers: { Authorization: HUB_AUTHORIZATION },
      });
      const result = await response.json();
      // Handle different response structures
      let assistantData = result.data;
      if (!assistantData) {
        // Maybe the response has assistant directly or no wrapper
        assistantData = result.assistant || result;
      }
      return { success: true, data: assistantData };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get installed assistants
  ipcMain.handle('agent:getInstalledAssistants', async () => {
    try {
      const assistants = await getInstalledAssistants();
      return { success: true, data: assistants };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Download and install assistant
  ipcMain.handle('agent:downloadAndInstall', async (_event, { assistantName, sourceUrl, version, checksum, assistantMeta, selectedSkillIds = [] }) => {
    try {
      console.log('[AgentStore IPC] downloadAndInstall:', { assistantName, sourceUrl, selectedSkillIds });
      if (!sourceUrl) {
        return { success: false, error: `sourceUrl is undefined for assistant ${assistantName}` };
      }

      const zipBuffer = await downloadFileBuffer(sourceUrl, { userAgent: 'Moss-AssistantHub/1.0' });
      console.log('[AgentStore IPC] Downloaded bytes:', zipBuffer.length);

      if (checksum) {
        const isValid = await verifyChecksum(zipBuffer, checksum);
        if (!isValid) {
          console.warn('[AgentStore IPC] Checksum mismatch, continuing anyway');
        }
      }

      await fsp.mkdir(ASSISTANT_HUB_DIR, { recursive: true });

      const assistantDir = path.join(ASSISTANT_HUB_DIR, assistantName);
      await fsp.rm(assistantDir, { recursive: true, force: true });
      await fsp.mkdir(assistantDir, { recursive: true });

      await extractAssistantZip(zipBuffer, assistantDir);

      const ruleFile = await resolveAssistantRuleFile(assistantDir, assistantName);

      // Install associated skills
      const installedSkillNames = [];
      const failedSkillIds = [];
      const allAssociatedSkillIds = [];
      const enabledSkillNames = new Set();

      if (selectedSkillIds && selectedSkillIds.length > 0) {
        // Get current installed skills
        const installedSkills = await getInstalledSkills();
        const installedSkillLookup = buildInstalledSkillLookup(installedSkills);

        for (const skillId of selectedSkillIds) {
          allAssociatedSkillIds.push(skillId);

          const skillDetailRes = await fetch(`${SKILL_HUB_BASE_URL}/${skillId}`, {
            headers: { Authorization: HUB_AUTHORIZATION },
          });
          if (!skillDetailRes.ok) {
            failedSkillIds.push(skillId);
            continue;
          }
          const skillDetailData = await skillDetailRes.json();

          if (skillDetailData.success && skillDetailData.data?.skill) {
            const skillInfo = skillDetailData.data.skill;
            const skillName = skillInfo.name;
            const existingSkill = installedSkillLookup.get(String(skillId)) || installedSkillLookup.get(skillName);

            if (existingSkill) {
              enabledSkillNames.add(existingSkill.name || skillName);
              continue;
            }

            // Install the skill
            const versions = skillDetailData.data.versions || [];
            if (!versions || versions.length === 0) {
              console.warn('[AgentStore IPC] Skill has no versions:', skillName);
              failedSkillIds.push(skillId);
              continue;
            }

            const latestVersion = versions[0];
            if (!latestVersion?.source_url) {
              console.warn('[AgentStore IPC] Skill has no source_url:', skillName);
              failedSkillIds.push(skillId);
              continue;
            }

            try {
              const skillZipBuffer = await downloadFileBuffer(latestVersion.source_url, { userAgent: 'Moss-AssistantHub/1.0' });
              if (latestVersion.checksum) {
                const isValid = await verifyChecksum(skillZipBuffer, latestVersion.checksum);
                if (!isValid) {
                  console.warn('[AgentStore IPC] Skill checksum mismatch:', skillName);
                }
              }

              await installSkillFromZip(skillZipBuffer, skillName, skillInfo, latestVersion.version);
              installedSkillNames.push(skillName);
              enabledSkillNames.add(skillName);
              installedSkillLookup.set(skillName, { id: skillInfo.id, name: skillName, source: path.join(MOSS_HOME, 'skills', 'hub', skillName) });
              if (skillInfo.id !== undefined && skillInfo.id !== null) {
                installedSkillLookup.set(String(skillInfo.id), { id: skillInfo.id, name: skillName, source: path.join(MOSS_HOME, 'skills', 'hub', skillName) });
              }
            } catch (skillErr) {
              console.warn('[AgentStore IPC] Failed to install skill:', skillId, skillErr);
              failedSkillIds.push(skillId);
            }
          } else {
            failedSkillIds.push(skillId);
          }
        }
      }

      const meta = {
        id: assistantMeta?.id || '',
        name: assistantName,
        display_name: assistantMeta?.display_name || assistantMeta?.name || assistantName,
        description: assistantMeta?.description || '',
        avatar: assistantMeta?.avatar || '',
        emoji: assistantMeta?.emoji || null,
        category: assistantMeta?.category || '',
        categories: assistantMeta?.categories || [],
        source_type: 'hub',
        tag: 'hub',
        is_builtin: false,
        enabled: true,
        installed_version: version,
        installed_at: new Date().toISOString(),
        ruleFile: ruleFile,
        skills: allAssociatedSkillIds,
        enabledSkills: Array.from(enabledSkillNames),
      };

      await fsp.writeFile(path.join(assistantDir, ASSISTANT_META_FILE), JSON.stringify(meta, null, 2), 'utf-8');

      return {
        success: true,
        assistantName,
        version,
        installedSkills: installedSkillNames,
        failedSkills: failedSkillIds,
      };
    } catch (err) {
      console.error('[AgentStore IPC] Install error:', err);
      return { success: false, error: err.message };
    }
  });

  // Uninstall assistant
  ipcMain.handle('agent:uninstall', async (_event, { assistantName, sourcePath }) => {
    try {
      const result = sourcePath
        ? { dir: sourcePath }
        : findAssistantDir(assistantName);

      if (!result) {
        return { success: false, error: 'Assistant not found' };
      }

      // Check if builtin
      const metaPath = path.join(result.dir, ASSISTANT_META_FILE);
      try {
        const metaContent = await fsp.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(metaContent);
        if (meta.is_builtin === true) {
          return { success: false, error: 'Builtin assistants cannot be uninstalled' };
        }
      } catch {
        // No meta file, allow uninstall
      }

      await fsp.rm(result.dir, { recursive: true, force: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Update assistant meta
  ipcMain.handle('agent:updateAssistantMeta', async (_event, { assistantName, updates }) => {
    try {
      const result = findAssistantDir(assistantName);
      if (!result) {
        return { success: false, error: 'Assistant not found' };
      }

      const metaPath = path.join(result.dir, ASSISTANT_META_FILE);
      let meta = {};
      try {
        const raw = await fsp.readFile(metaPath, 'utf-8');
        meta = JSON.parse(raw);
      } catch {
        // Start fresh if no meta
      }

      const merged = { ...meta, ...updates };
      await fsp.writeFile(metaPath, JSON.stringify(merged, null, 2), 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Fetch skill details by IDs
  ipcMain.handle('agent:fetchSkillDetailsByIds', async (_event, { skillIds }) => {
    try {
      if (!skillIds || skillIds.length === 0) {
        return { success: true, data: [] };
      }

      const results = await Promise.all(
        skillIds.map(async (id) => {
          try {
            const response = await fetch(`${SKILL_HUB_BASE_URL}/${id}`, {
              headers: { Authorization: HUB_AUTHORIZATION },
            });
            const data = await response.json();
            if (data.success && data.data?.skill) {
              return data.data.skill;
            }
            return null;
          } catch {
            return null;
          }
        })
      );

      return { success: true, data: results.filter(Boolean) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Read assistant rule file content
  ipcMain.handle('agent:getAssistantContext', async (_event, { assistantName }) => {
    try {
      const assistantDir = await findAssistantDirByName(assistantName, ASSISTANT_SEARCH_DIRS);
      if (!assistantDir) {
        return { success: false, error: 'Assistant not found' };
      }

      const assistantContext = await readAssistantContext(assistantDir, assistantName);
      return { success: true, data: assistantContext.rules };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('agent:getSkillInfosByIds', async (_event, { skillIds }) => {
    try {
      if (!skillIds || skillIds.length === 0) {
        return { success: true, data: [] };
      }

      const installedSkills = await getInstalledSkills();
      const results = resolveInstalledSkillInfos(skillIds, installedSkills);
      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get assistant context (rules) + skills info combined
  ipcMain.handle('agent:getAssistantContextWithSkills', async (_event, { assistantName }) => {
    try {
      if (!assistantName) {
        return { success: true, data: { rules: '', skillsInfo: [] } };
      }

      let rules = '';
      let enabledSkills = [];
      const assistantDir = await findAssistantDirByName(assistantName, ASSISTANT_SEARCH_DIRS);
      if (assistantDir) {
        const assistantContext = await readAssistantContext(assistantDir, assistantName);
        rules = assistantContext.rules;
        enabledSkills = assistantContext.enabledSkillIdentifiers;
      }

      const installedSkills = await getInstalledSkills();
      const skillsInfo = resolveInstalledSkillInfos(enabledSkills, installedSkills);

      return { success: true, data: { rules, skillsInfo } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}
