import { dcClient } from './client'
import { createOperationsApi } from './operations-core'

export type {
  AuditEventItem,
  BillingOrderItem,
  CreditApplicationItem,
  InvitationCodeItem,
  LegacyEnvelope,
  LegacyPage,
  RechargeRecordItem,
} from './operations-core'

export const operationsApi = createOperationsApi({
  get: path => dcClient.get(path),
  post: (path, body) => dcClient.post(path, body),
  delete: path => dcClient.delete(path),
})
