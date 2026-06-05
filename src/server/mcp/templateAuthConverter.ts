/**
 * MCP Template Auth Config Converter
 *
 * Converts between:
 * - Template layered auth_config_json ({ pre_filled, user_items, oauth_fields, ... })
 * - McpServer flat auth_config_json ({ header_name, prefix, token, ... })
 *
 * This module is shared by both admin install (mcpAdmin.ts) and user install (mcpUser.ts).
 */

import type { TemplateAuthConfig, AuthCredentials, AuthUserItem } from './types.js'

// ============================================================
// Parse helpers
// ============================================================

function parseTemplateAuthConfig(json: string | null): TemplateAuthConfig | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as TemplateAuthConfig
    }
  } catch { /* ignore */ }
  return null
}

// ============================================================
// Main converter: template layered → McpServer flat
// ============================================================

export function convertTemplateAuthToServerAuth(
  templateAuthConfigJson: string | null,
  credentials: AuthCredentials,
): { auth_config_json: string | null; secret_ref: string | null } {
  const config = parseTemplateAuthConfig(templateAuthConfigJson)
  if (!config) return { auth_config_json: null, secret_ref: null }

  switch (config.auth_type) {
    case 'none':
      return { auth_config_json: null, secret_ref: null }

    case 'bearer': {
      const pre = config.pre_filled ?? {}
      const result: Record<string, string> = {
        header_name: pre.header_name || 'Authorization',
        prefix: pre.prefix ?? 'Bearer',
        token: credentials.token ?? '',
      }
      return { auth_config_json: JSON.stringify(result), secret_ref: null }
    }

    case 'basic': {
      const pre = config.pre_filled ?? {}
      const result: Record<string, string> = {
        header_name: pre.header_name || 'Authorization',
        username: credentials.username ?? '',
        password: credentials.password ?? '',
      }
      return { auth_config_json: JSON.stringify(result), secret_ref: null }
    }

    case 'api_key': {
      const pre = config.pre_filled ?? {}
      const result: Record<string, string> = {
        header_name: pre.header_name || 'X-API-Key',
        api_key: credentials.api_key ?? '',
      }
      return { auth_config_json: JSON.stringify(result), secret_ref: null }
    }

    case 'oauth': {
      // Build base OAuthAuthConfig from oauth_fields + credentials
      const oauthFields = config.oauth_fields ?? []
      const result: Record<string, string> = {
        client_id: credentials.client_id ?? '',
        client_secret: credentials.client_secret ?? '',
        authorization_url: '',
        token_url: '',
      }
      // Map oauth_fields: use default_value for reserved keys, credentials override
      for (const field of oauthFields) {
        if (field.key === 'authorization_url') {
          result.authorization_url = credentials.authorization_url ?? field.default_value ?? ''
        } else if (field.key === 'token_url') {
          result.token_url = credentials.token_url ?? field.default_value ?? ''
        } else {
          // Custom fields: credential value > default_value
          result[field.key] = credentials[field.key] ?? field.default_value ?? ''
        }
      }
      // Optional scopes
      if (credentials.scopes) {
        result.scopes = credentials.scopes
      }
      return { auth_config_json: JSON.stringify(result), secret_ref: null }
    }

    case 'custom_header': {
      // Merge custom_header_items keys with credential values
      const items = config.custom_header_items ?? []
      const result: Record<string, string> = {}
      for (const item of items) {
        result[item.key] = credentials[item.key] ?? ''
      }
      return { auth_config_json: Object.keys(result).length > 0 ? JSON.stringify(result) : null, secret_ref: null }
    }

    case 'secret_ref': {
      return { auth_config_json: null, secret_ref: config.secret_ref ?? null }
    }

    default:
      return { auth_config_json: null, secret_ref: null }
  }
}

// ============================================================
// Extract auth user items schema (for sanitizeTemplateForUser)
// ============================================================

export function extractAuthUserItems(authConfigJson: string | null): AuthUserItem[] {
  const config = parseTemplateAuthConfig(authConfigJson)
  if (!config) return []

  switch (config.auth_type) {
    case 'bearer':
    case 'basic':
    case 'api_key':
    case 'oauth':
      return (config.user_items ?? []).map(item => ({
        name: item.name,
        key: item.key,
        ...(item.description ? { description: item.description } : {}),
        required: item.required,
      }))

    case 'custom_header':
      return (config.custom_header_items ?? []).map(item => ({
        name: item.name,
        key: item.key,
        ...(item.description ? { description: item.description } : {}),
        required: item.required,
      }))

    case 'none':
    case 'secret_ref':
    default:
      return []
  }
}

// ============================================================
// Validate required credentials before installation
// ============================================================

export function validateRequiredCredentials(
  authConfigJson: string | null,
  credentials: AuthCredentials,
): string[] {
  const config = parseTemplateAuthConfig(authConfigJson)
  if (!config) return []

  const missing: string[] = []

  switch (config.auth_type) {
    case 'bearer':
    case 'basic':
    case 'api_key':
    case 'oauth':
      for (const item of config.user_items ?? []) {
        if (item.required) {
          const val = credentials[item.key]
          if (!val || (typeof val === 'string' && val.trim() === '')) {
            missing.push(item.key)
          }
        }
      }
      break

    case 'custom_header':
      for (const item of config.custom_header_items ?? []) {
        if (item.required) {
          const val = credentials[item.key]
          if (!val || (typeof val === 'string' && val.trim() === '')) {
            missing.push(item.key)
          }
        }
      }
      break

    case 'secret_ref':
      if (!config.secret_ref) {
        missing.push('secret_ref')
      }
      break
  }

  return missing
}
