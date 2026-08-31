/**
 * @license
 * Copyright 2025 Sudowork (sudowork.ai)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DirectConnectStore } from '../../server/db.js';

/**
 * Agent (智能体) selection for IM channels.
 *
 * Three facts shape this module:
 *
 * 1. An agent is bound to a runtime session at spawn time — RuntimeService bakes
 *    `assistantName` into a pre-signed token as `assistant_id`, and uses it to resolve
 *    memory_mode / enabledSkills. There is no API to change it on a live session, so
 *    "switching" means terminating the session and creating a new one. The caller owns
 *    that; this module only decides *which* agent a chat should use.
 *
 * 2. One IM connection serves many chats. A WeCom bot can sit in several groups and be
 *    DM'd by several people, and each chat gets its own runtime session keyed by chatId
 *    ("group:<id>" / "user:<id>"). The active agent is therefore per (connection, chat),
 *    so switching in one group never disturbs another chat on the same bot.
 *
 * 3. Which agents a chat may choose from is the set visible to the connection's OWNER
 *    (the moss user who configured the plugin) — global, tenant and custom alike. That
 *    reuses the same visibility rules as the rest of the product rather than inventing a
 *    channel-specific allowlist.
 *
 * Selections live in channel_plugins.config_json so no schema change is needed:
 *   config.agent          -> { name } default for new chats on this connection
 *   config.chatAgents     -> { [chatId]: name } per-chat overrides
 */

/** An agent a chat can switch to. */
export interface IChannelAgentOption {
  /** Stable identifier used as `assistantName` when spawning a session. */
  name: string;
  /** Human-facing label, e.g. "联盟智引助手". */
  displayName: string;
  description?: string;
}

/** Resolves and persists the agent bound to each IM chat. */
export class ChannelAgentResolver {
  constructor(
    private db: DirectConnectStore,
    /**
     * Lists agents visible to a given moss user. Injected rather than imported so the
     * channels layer stays free of the agent-store/auth wiring (and so tests can supply
     * a fixed roster).
     */
    private listVisibleAgents: (userId: string) => Promise<IChannelAgentOption[]>,
  ) {}

  /** Agents the owner of this connection may pick from. Empty when the owner is unknown. */
  async listAgents(ownerUserId: string | undefined): Promise<IChannelAgentOption[]> {
    if (!ownerUserId) return [];
    try {
      return await this.listVisibleAgents(ownerUserId);
    } catch (error) {
      console.error('[ChannelAgentResolver] failed to list visible agents:', error);
      return [];
    }
  }

  /**
   * The agent this chat should run as: the chat's own override, else the connection
   * default, else null (meaning "no agent bound" — the runtime falls back to a generic
   * session with all skills).
   *
   * A stored agent that is no longer visible to the owner is ignored, so revoking access
   * takes effect on the next turn instead of leaving a chat pinned to a lost agent.
   */
  async resolveActiveAgent(params: {
    platform: string;
    /** Which connection's config to read. Each bot carries its own default + chat bindings. */
    pluginId?: string;
    chatId: string;
    ownerUserId: string | undefined;
  }): Promise<IChannelAgentOption | null> {
    const { platform, pluginId, chatId, ownerUserId } = params;
    if (!ownerUserId) return null;

    const config = this.readConfig(platform, pluginId, ownerUserId);
    const chatAgents = this.readChatAgents(config);
    const candidate =
      chatAgents[chatId] ||
      (typeof (config.agent as { name?: string } | undefined)?.name === 'string'
        ? String((config.agent as { name?: string }).name)
        : '');
    if (!candidate) return null;

    const available = await this.listAgents(ownerUserId);
    return available.find((a) => a.name === candidate) ?? null;
  }

  /**
   * Bind an agent to one chat, or clear the binding so the chat falls back to the
   * connection default. Rejects an agent the owner cannot see, so a stale name from a
   * chat command can never widen access.
   */
  async setChatAgent(params: {
    platform: string;
    /** Which connection's config to write. Each bot carries its own chat bindings. */
    pluginId?: string;
    chatId: string;
    ownerUserId: string | undefined;
    agentName: string | null;
  }): Promise<{ ok: true; agent: IChannelAgentOption | null } | { ok: false; error: string }> {
    const { platform, pluginId, chatId, ownerUserId, agentName } = params;
    if (!ownerUserId) return { ok: false, error: 'no plugin owner for this channel' };

    let resolved: IChannelAgentOption | null = null;
    if (agentName) {
      const available = await this.listAgents(ownerUserId);
      resolved = available.find((a) => a.name === agentName) ?? null;
      if (!resolved) return { ok: false, error: `agent not found: ${agentName}` };
    }

    const config = this.readConfig(platform, pluginId, ownerUserId);
    const chatAgents = { ...this.readChatAgents(config) };
    if (resolved) chatAgents[chatId] = resolved.name;
    else delete chatAgents[chatId];

    this.writeConfig(platform, pluginId, ownerUserId, { ...config, chatAgents });
    return { ok: true, agent: resolved };
  }

  /**
   * Match user input against the agent roster: exact name, exact display name, then a
   * case-insensitive match on either. Chat users type the label they see, which is the
   * display name, not the internal name.
   */
  matchAgent(input: string, agents: IChannelAgentOption[]): IChannelAgentOption | null {
    const query = input.trim();
    if (!query) return null;
    const exact = agents.find((a) => a.name === query || a.displayName === query);
    if (exact) return exact;
    const lower = query.toLowerCase();
    return (
      agents.find(
        (a) => a.name.toLowerCase() === lower || a.displayName.toLowerCase() === lower,
      ) ?? null
    );
  }

  private readConfig(platform: string, pluginId: string | undefined, ownerUserId: string): Record<string, unknown> {
    const row = this.db.getChannelPlugin(pluginId || `${platform}_default`, ownerUserId);
    if (!row?.config_json) return {};
    try {
      const parsed = JSON.parse(String(row.config_json));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private readChatAgents(config: Record<string, unknown>): Record<string, string> {
    const raw = config.chatAgents;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [chatId, name] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof name === 'string' && name) out[chatId] = name;
    }
    return out;
  }

  private writeConfig(
    platform: string,
    pluginIdIn: string | undefined,
    ownerUserId: string,
    config: Record<string, unknown>,
  ): void {
    const pluginId = pluginIdIn || `${platform}_default`;
    const row = this.db.getChannelPlugin(pluginId, ownerUserId);
    if (!row) return;
    this.db.upsertChannelPlugin({
      id: pluginId,
      type: String(row.type),
      name: String(row.name),
      enabled: Number(row.enabled) ? 1 : 0,
      status: String(row.status),
      credentials_json:
        typeof row.credentials_json === 'string' ? row.credentials_json : null,
      config_json: JSON.stringify(config),
      last_connected: typeof row.last_connected === 'number' ? row.last_connected : null,
      user_id: ownerUserId,
      org_id: row.org_id ? String(row.org_id) : null,
    });
  }
}
