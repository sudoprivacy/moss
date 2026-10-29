'use client'

import { DashboardLayout } from '@/components/dashboard-layout'
import AgentInventorySection from '@/components/agent-inventory-section'

/**
 * The ledger is a governance and audit view. Keeping it outside the Expert
 * Library prevents operational registration details from becoming part of the
 * ordinary browse/use flow.
 */
export default function AgentLedgerPage() {
  return (
    <DashboardLayout
      title="智能体台账"
      description="管理专家身份、版本、运行准入和审计关联。"
    >
      <AgentInventorySection query="" />
    </DashboardLayout>
  )
}
