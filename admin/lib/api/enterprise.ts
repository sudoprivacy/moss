import { dcClient } from './client'
import type { EnterpriseConfig, EnterpriseConfigResponse } from './types'

export function getEnterpriseConfig(): Promise<EnterpriseConfigResponse> {
  return dcClient.get<EnterpriseConfigResponse>('/api/v1/tenant/config')
}

export function updateEnterpriseConfig(
  data: Partial<EnterpriseConfig>,
): Promise<EnterpriseConfigResponse> {
  return dcClient.patch<EnterpriseConfigResponse>('/api/v1/settings/enterprise', data)
}

export interface UploadLogoResponse {
  success: boolean;
  data: {
    url: string;
  };
}

export function uploadLogo(file: File): Promise<UploadLogoResponse> {
  return dcClient.post<UploadLogoResponse>('/api/v1/upload/logo', file, {
    headers: {
      'Content-Type': file.type,
    },
  })
}
