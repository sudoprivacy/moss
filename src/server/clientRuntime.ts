import type { AuthService } from './auth/service.js'
import { resolveModelSelection } from './modelProviders.js'
import { getAvailableModels } from './modelListCache.js'

export interface ExecutionCapabilities {
  isLocalAllowed: boolean
  isRemoteAllowed: boolean
  defaultTarget: 'local' | 'remote'
}

/** Execution permissions are independent of password/SSO authentication. */
export function resolveExecutionCapabilities(policy: Record<string, unknown>, isUserLocalAllowed = true): ExecutionCapabilities {
  const execution = policy.execution as Partial<ExecutionCapabilities> | undefined
  const isLocalAllowed = isUserLocalAllowed && execution?.isLocalAllowed !== false
  const isRemoteAllowed = execution?.isRemoteAllowed !== false
  return {
    isLocalAllowed,
    isRemoteAllowed,
    defaultTarget: isLocalAllowed && execution?.defaultTarget !== 'remote' ? 'local' : isRemoteAllowed ? 'remote' : 'local',
  }
}

type RuntimeAuthService = Pick<AuthService, 'getOrganizationClientPolicy' | 'isUserLocalExecutionAllowed' | 'getOrganizationSystemSettings' | 'getUserModelCredential' | 'ensureUserSudorouterAccount'>

/** Build a user-scoped desktop configuration; shared server keys never leave Moss. */
export async function buildClientRuntime(
  authService: RuntimeAuthService,
  user: { id: string; orgId: string },
  discoverModels = getAvailableModels,
) {
  const execution = resolveExecutionCapabilities(
    await authService.getOrganizationClientPolicy(user.orgId),
    await authService.isUserLocalExecutionAllowed(user.id),
  )
  const identity = { userId: user.id, organizationId: user.orgId }
  const unavailable = (status: 'policy_denied' | 'credential_pending' | 'provider_unavailable' | 'models_unavailable') => ({
    execution,
    localRuntime: { ...identity, status },
    models: [] as string[],
  })
  if (!execution.isLocalAllowed) return unavailable('policy_denied')

  let credential
  try {
    credential = await authService.getUserModelCredential(user.id)
    if (!credential) {
      await authService.ensureUserSudorouterAccount(user.id)
      credential = await authService.getUserModelCredential(user.id)
    }
  } catch {
    return unavailable('credential_pending')
  }
  if (!credential?.sudorouterKey) return unavailable('credential_pending')

  const settings = await authService.getOrganizationSystemSettings(user.orgId)
  const provider = settings.modelProviders.find(item => item.id === 'legacy-default' && item.enabled)
  if (!provider) return unavailable('provider_unavailable')
  // A Sudorouter key must never be sent to an unrelated configured provider.
  const available = await discoverModels({
    settings: { ...settings, apiKey: '', modelProviders: [provider] },
    orgId: user.orgId,
    userApiKey: credential.sudorouterKey,
  }).catch(() => [])
  const models = available.map(model => model.modelId).filter(id => !/embedding|rerank|whisper|tts|dall-e|image|moderation/i.test(id))
  if (models.length === 0) return unavailable('models_unavailable')

  return {
    execution,
    localRuntime: { ...identity, status: 'ready' as const, protocol: provider.protocol },
    sudorouter_key: credential.sudorouterKey,
    model_service_url: provider.baseUrl,
    models,
    scode_auto_model: models.includes(resolveModelSelection([provider], provider.id, settings.model, settings.model).modelId) ? resolveModelSelection([provider], provider.id, settings.model, settings.model).modelId : models[0],
  }
}
