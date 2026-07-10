import os from 'os'
import path from 'path'

// Support MOSS_HOME environment variable for Docker/container environments
export const MOSS_HOME = process.env.MOSS_HOME || path.join(os.homedir(), '.moss')
export const MOSS_SKILLS_DIR = path.join(MOSS_HOME, 'skills')
export const USER_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')
export const MOSS_SKILLS_HUB_DIR = path.join(MOSS_SKILLS_DIR, 'hub')
export const MOSS_SKILLS_SYSTEM_DIR = path.join(MOSS_SKILLS_DIR, 'system')
export const MOSS_SKILLS_CUSTOM_DIR = path.join(MOSS_SKILLS_DIR, 'custom')
export const MOSS_SKILLS_TENANT_DIR = path.join(MOSS_SKILLS_DIR, 'tenant')
// Staging area for non-admin-published tenant skills awaiting approval. Kept OUT
// of MANAGED_SKILL_SEARCH_DIRS on purpose so pending files are invisible to the
// runtime dir-scan (and every store tab) until an admin approves and they are
// MOVED into MOSS_SKILLS_TENANT_DIR.
export const MOSS_SKILLS_TENANT_PENDING_DIR = path.join(MOSS_SKILLS_DIR, 'tenant-pending')
export const SKILL_HUB_META_FILE = '_moss_meta.json'

export const MANAGED_SKILL_SEARCH_DIRS = [
  USER_SKILLS_DIR,
  MOSS_SKILLS_HUB_DIR,
  MOSS_SKILLS_SYSTEM_DIR,
  MOSS_SKILLS_CUSTOM_DIR,
  MOSS_SKILLS_TENANT_DIR,
] as const
