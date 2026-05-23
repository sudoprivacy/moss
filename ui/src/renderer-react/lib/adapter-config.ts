import * as React from 'react'
import type { AdapterFileConfig } from '../types'

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6

function createPairingCode(): string {
  let code = ''
  while (code.length < CODE_LENGTH) {
    const array = new Uint8Array(1)
    crypto.getRandomValues(array)
    const maxValid = Math.floor(256 / SAFE_ALPHABET.length) * SAFE_ALPHABET.length
    if (array[0]! < maxValid) {
      code += SAFE_ALPHABET[array[0]! % SAFE_ALPHABET.length]
    }
  }
  return code
}

type AdapterState = {
  config: AdapterFileConfig
  isLoading: boolean
  error: string | null
}

export function useAdapterConfig() {
  const [state, setState] = React.useState<AdapterState>({
    config: {},
    isLoading: false,
    error: null,
  })

  const fetchConfig = React.useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))
    try {
      const config = await window.agentDesktop.getAdapterConfig()
      setState({ config, isLoading: false, error: null })
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load adapter config',
      }))
    }
  }, [])

  const updateConfig = React.useCallback(async (patch: Partial<AdapterFileConfig>) => {
    const config = await window.agentDesktop.updateAdapterConfig(patch)
    setState((prev) => ({ ...prev, config }))
    return config
  }, [])

  const generatePairingCode = React.useCallback(async (): Promise<string> => {
    const code = createPairingCode()
    const now = Date.now()
    await updateConfig({
      pairing: {
        code,
        expiresAt: now + 60 * 60 * 1000,
        createdAt: now,
      },
    })
    return code
  }, [updateConfig])

  const removePairedUser = React.useCallback(
    async (platform: 'telegram' | 'feishu', userId: string | number) => {
      const { config } = state
      const platformConfig = config[platform]
      if (!platformConfig) return
      const pairedUsers = (platformConfig.pairedUsers ?? []).filter(
        (u) => String(u.userId) !== String(userId),
      )
      await updateConfig({
        [platform]: { ...platformConfig, pairedUsers },
      } as Partial<AdapterFileConfig>)
    },
    [state.config, updateConfig],
  )

  return {
    config: state.config,
    isLoading: state.isLoading,
    error: state.error,
    fetchConfig,
    updateConfig,
    generatePairingCode,
    removePairedUser,
  }
}
