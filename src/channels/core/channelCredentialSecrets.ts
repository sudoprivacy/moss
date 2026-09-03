/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IM 敏感凭据的 Nexus 收敛模块(纯函数)。
 *
 * 列出的敏感字段只从 Nexus 读写,credentials_json 不再落这些字段的明文:
 *   telegram: token
 *   lark:     appSecret / encryptKey / verificationToken
 *   dingtalk: clientSecret
 *   wecom:    secret
 *
 * namespace = `im:user:{userId}:{pluginId}`,key = 字段名(每字段一条独立 secret)。
 * nexusClient 作为参数传入,本模块不自持依赖。
 */

import type { NexusClient } from '../../server/nexus/nexusClient.js';
import type { PluginType } from '../types.js';
import { channelTokenFingerprint } from '../types.js';

type Creds = Record<string, unknown>;

/**
 * 各平台需托管到 Nexus 的敏感字段。**未列入的 type(wechat 扫码、扩展插件)一律不处理、
 * 凭据保持原样** —— 严格聚焦需求列出的 4 平台字段,不扩大范围。
 */
export const CHANNEL_SENSITIVE_FIELDS: Partial<Record<PluginType, string[]>> = {
  telegram: ['token'],
  lark: ['appSecret', 'encryptKey', 'verificationToken'],
  dingtalk: ['clientSecret'],
  wecom: ['secret'],
};

/** sanitized credentials_json 里的内部元字段(绝不下发给前端表单)。 */
const INTERNAL_META_FIELDS = ['tokenFingerprint', 'configuredSecretFields'] as const;

function sensitiveFields(type: PluginType): string[] {
  return CHANNEL_SENSITIVE_FIELDS[type] ?? [];
}

export function channelSecretNamespace(userId: string, pluginId: string): string {
  return `im:user:${userId}:${pluginId}`;
}

/**
 * 落库前:把敏感字段写入 Nexus,返回剥离敏感字段后的 sanitized 副本(供 credentials_json)。
 * - 非空字段 putSecret;空字段 deleteSecret(用户清空/更换,幂等安全)。
 * - telegram 仅在 token 非空时追加 tokenFingerprint(供 DB 层重复检测,不泄露明文)。
 * - configuredSecretFields 记录已存入 Nexus 的敏感字段名,供前端"已配置"判断(免每次查 Nexus)。
 */
export async function persistChannelSecrets(
  nexus: NexusClient,
  userId: string,
  pluginId: string,
  type: PluginType,
  credentials: Creds | undefined,
): Promise<Creds> {
  const src: Creds = { ...(credentials ?? {}) };
  const fields = sensitiveFields(type);
  if (fields.length === 0) return src;

  const ns = channelSecretNamespace(userId, pluginId);
  const sanitized: Creds = { ...src };
  const configured: string[] = [];

  for (const field of fields) {
    const value = src[field];
    if (typeof value === 'string' && value !== '') {
      await nexus.putSecret(ns, field, value, userId);
      configured.push(field);
    } else {
      await nexus.deleteSecret(ns, field, userId);
    }
    delete sanitized[field];
  }

  delete sanitized.tokenFingerprint;
  if (type === 'telegram') {
    const token = src.token;
    if (typeof token === 'string' && token !== '') {
      sanitized.tokenFingerprint = channelTokenFingerprint(token);
    }
  }

  sanitized.configuredSecretFields = configured;
  return sanitized;
}

/**
 * 读取路径(startEnabledPlugins / getPluginCredentials):
 * **先剔除传入 credentials 里的敏感字段残留**(丢弃存量旧行 credentials_json 可能残留的明文),
 * 再从 Nexus 取回、仅合并 value!==null 的项。保证敏感字段值唯一来源是 Nexus。
 */
export async function hydrateChannelSecrets(
  nexus: NexusClient,
  userId: string,
  pluginId: string,
  type: PluginType,
  credentials: Creds | undefined,
): Promise<Creds> {
  const result: Creds = { ...(credentials ?? {}) };
  const fields = sensitiveFields(type);
  if (fields.length === 0) return result;

  for (const field of fields) delete result[field];

  const ns = channelSecretNamespace(userId, pluginId);
  const secrets = await nexus.listSecrets(ns, userId);
  for (const s of secrets) {
    if (s.value !== null && fields.includes(s.key)) {
      result[s.key] = s.value;
    }
  }
  return result;
}

/**
 * 写入补全(enablePlugin):仅对传入**缺失(key 为 undefined)**的敏感字段从 Nexus 补入;
 * 传入已有的字段(含空串)保留不动,不覆盖用户新输入。用于一键启用只传非敏感字段的场景。
 */
export async function fillMissingSecrets(
  nexus: NexusClient,
  userId: string,
  pluginId: string,
  type: PluginType,
  credentials: Creds | undefined,
): Promise<Creds> {
  const result: Creds = { ...(credentials ?? {}) };
  const fields = sensitiveFields(type);
  if (fields.length === 0) return result;

  const ns = channelSecretNamespace(userId, pluginId);
  for (const field of fields) {
    if (result[field] === undefined) {
      const got = await nexus.getSecret(ns, field, userId);
      if (got && got.value !== null) {
        result[field] = got.value;
      }
    }
  }
  return result;
}

/** 删除连接时清理该连接在 Nexus 下的全部敏感 secret。 */
export async function deleteChannelSecrets(
  nexus: NexusClient,
  userId: string,
  pluginId: string,
  type: PluginType,
): Promise<void> {
  const fields = sensitiveFields(type);
  if (fields.length === 0) return;
  const ns = channelSecretNamespace(userId, pluginId);
  for (const field of fields) {
    await nexus.deleteSecret(ns, field, userId);
  }
}

/**
 * 下发给前端前(getPlugins / getPlugin):**强制剔除敏感字段 + 内部元字段**,并抽出
 * configuredSecretFields 供前端"已配置"判断。强制剔除(而非假设已剥离)以应对"不迁移"下
 * 存量旧行 credentials_json 残留的明文,防止经列表继续外泄。
 */
export function stripChannelSecretsForClient(
  type: PluginType,
  credentials: Creds | undefined,
): { credentials: Creds | undefined; configuredSecretFields: string[] } {
  if (!credentials) return { credentials: undefined, configuredSecretFields: [] };
  const result: Creds = { ...credentials };
  const configured = Array.isArray(result.configuredSecretFields)
    ? (result.configuredSecretFields as string[])
    : [];
  for (const field of sensitiveFields(type)) delete result[field];
  for (const meta of INTERNAL_META_FIELDS) delete result[meta];
  return { credentials: result, configuredSecretFields: configured };
}

/** 剔除内部元字段(getPluginCredentials 回填前端前用),保留真实凭据字段。 */
export function stripInternalMeta(credentials: Creds | undefined): Creds | undefined {
  if (!credentials) return credentials;
  const result: Creds = { ...credentials };
  for (const meta of INTERNAL_META_FIELDS) delete result[meta];
  return result;
}
