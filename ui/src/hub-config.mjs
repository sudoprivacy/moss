function normalizeHubApiBaseUrl(rawValue) {
  const trimmed = String(rawValue || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

const DEFAULT_HUB_API_BASE_URL = 'https://sudoclawhub.sudoprivacy.com/api';
const configuredHubApiBaseUrl = normalizeHubApiBaseUrl(
  process.env.MOSS_HUB_API_BASE_URL || process.env.MOSS_HUB_BASE_URL || '',
);

export const HUB_API_BASE_URL = configuredHubApiBaseUrl || DEFAULT_HUB_API_BASE_URL;
export const HUB_AUTHORIZATION = String(process.env.MOSS_HUB_AUTHORIZATION || 'sud0@sudo').trim() || 'sud0@sudo';

export const HUB_CATEGORIES_URL = `${HUB_API_BASE_URL}/categories`;
export const ASSISTANT_HUB_BASE_URL = `${HUB_API_BASE_URL}/assistants`;
export const ASSISTANT_HUB_CURSOR_URL = `${ASSISTANT_HUB_BASE_URL}/cursor`;
export const SKILL_HUB_BASE_URL = `${HUB_API_BASE_URL}/skills`;
export const SKILL_HUB_CURSOR_URL = `${SKILL_HUB_BASE_URL}/cursor`;
