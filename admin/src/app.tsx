import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { DashboardShell } from './layouts/dashboard-shell'

const LoginPage = lazy(() => import('./pages/login-page'))
const DashboardPage = lazy(() => import('./pages/dashboard-page'))
const BudgetPage = lazy(() => import('./pages/budget-page'))
const SessionsPage = lazy(() => import('./pages/sessions-page'))
const CabinConversationsPage = lazy(() => import('./pages/cabin-conversations-page'))
const UsersPage = lazy(() => import('./pages/users-page'))
const ApiKeysPage = lazy(() => import('./pages/api-keys-page'))
const SystemSettingsPage = lazy(() => import('./pages/system-settings-page'))
const ChannelsPage = lazy(() => import('./pages/channels-page'))
const CorpAppsPage = lazy(() => import('./pages/corp-apps-page'))
const SkillStorePage = lazy(() => import('./pages/skill-store-page'))
const AgentHubPage = lazy(() => import('./pages/agent-hub-page'))
const EnterpriseConfigPage = lazy(() => import('./pages/enterprise-config-page'))
const DocumentCenterPage = lazy(() => import('./pages/document-center-page'))
const ExternalSourcesPage = lazy(() => import('./pages/external-sources-page'))
const BuildJobsPage = lazy(() => import('./pages/build-jobs-page'))
const ConfigItemsPage = lazy(() => import('./pages/secrets/config-items-page'))
const EnterpriseSecretsPage = lazy(() => import('./pages/secrets/enterprise-secrets-page'))
const DepartmentSecretsPage = lazy(() => import('./pages/secrets/department-secrets-page'))
const UserCredentialsPage = lazy(() => import('./pages/secrets/user-credentials-page'))
const AuditLogPage = lazy(() => import('./pages/secrets/audit-log-page'))
const RotationAlertsPage = lazy(() => import('./pages/secrets/rotation-alerts-page'))
const CronJobsPage = lazy(() => import('./pages/cron-jobs-page'))
const EventTriggersPage = lazy(() => import('./pages/event-triggers-page'))
const McpServersPage = lazy(() => import('./pages/mcp/mcp-servers-page'))
const McpEnterpriseServersPage = lazy(() => import('./pages/mcp/mcp-enterprise-servers-page'))
const McpDepartmentServersPage = lazy(() => import('./pages/mcp/mcp-department-servers-page'))
const McpPolicyPage = lazy(() => import('./pages/mcp/mcp-policy-page'))
const McpAuditLogPage = lazy(() => import('./pages/mcp/mcp-audit-log-page'))
const McpApprovalsPage = lazy(() => import('./pages/mcp/mcp-approvals-page'))
const McpTemplatesPage = lazy(() => import('./pages/mcp/mcp-templates-page'))
const SessionDetailPage = lazy(() =>
  import('./pages/session-detail-page').then((module) => ({
    default: module.SessionDetailPage,
  })),
)

function RouteLoader() {
  return (
    <div className="flex min-h-[320px] items-center justify-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  )
}

function SuspendedRoute({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<RouteLoader />}>{children}</Suspense>
}

function SessionDetailRoute() {
  const { id } = useParams<{ id: string }>()

  if (!id) {
    return <Navigate to="/sessions" replace />
  }

  return <SessionDetailPage sessionId={id} />
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <SuspendedRoute>
            <LoginPage />
          </SuspendedRoute>
        }
      />
      <Route element={<DashboardShell />}>
        <Route
          index
          element={
            <SuspendedRoute>
              <DashboardPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/budget"
          element={
            <SuspendedRoute>
              <BudgetPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/users"
          element={
            <SuspendedRoute>
              <UsersPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/sessions"
          element={
            <SuspendedRoute>
              <SessionsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/sessions/:id"
          element={
            <SuspendedRoute>
              <SessionDetailRoute />
            </SuspendedRoute>
          }
        />
        <Route
          path="/cabin/conversations"
          element={
            <SuspendedRoute>
              <CabinConversationsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/api-keys"
          element={
            <SuspendedRoute>
              <ApiKeysPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <SuspendedRoute>
              <SystemSettingsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/channels"
          element={
            <SuspendedRoute>
              <ChannelsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/corp-apps"
          element={
            <SuspendedRoute>
              <CorpAppsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/settings/skill"
          element={
            <SuspendedRoute>
              <SkillStorePage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/settings/agents"
          element={
            <SuspendedRoute>
              <AgentHubPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/settings/enterprise"
          element={
            <SuspendedRoute>
              <EnterpriseConfigPage />
            </SuspendedRoute>
          }
        />
        <Route path="/document-center" element={<Navigate to="/document-center/tree" replace />} />
        <Route
          path="/document-center/tree"
          element={
            <SuspendedRoute>
              <DocumentCenterPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/document-center/sources"
          element={
            <SuspendedRoute>
              <ExternalSourcesPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/document-center/build-jobs"
          element={
            <SuspendedRoute>
              <BuildJobsPage />
            </SuspendedRoute>
          }
        />
        {/* Secrets Management */}
        <Route
          path="/secrets/config-items"
          element={
            <SuspendedRoute>
              <ConfigItemsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/secrets/enterprise"
          element={
            <SuspendedRoute>
              <EnterpriseSecretsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/secrets/department"
          element={
            <SuspendedRoute>
              <DepartmentSecretsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/secrets/user-credentials"
          element={
            <SuspendedRoute>
              <UserCredentialsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/secrets/audit-log"
          element={
            <SuspendedRoute>
              <AuditLogPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/secrets/rotation-alerts"
          element={
            <SuspendedRoute>
              <RotationAlertsPage />
            </SuspendedRoute>
          }
        />
        {/* Cron Jobs Management */}
        <Route
          path="/cron"
          element={
            <SuspendedRoute>
              <CronJobsPage />
            </SuspendedRoute>
          }
        />
        {/* Event Triggers: external systems POST events to run an agent */}
        <Route
          path="/event-triggers"
          element={
            <SuspendedRoute>
              <EventTriggersPage />
            </SuspendedRoute>
          }
        />
        {/* MCP Management */}
        <Route path="/mcp" element={<Navigate to="/mcp/servers/enterprise" replace />} />
        <Route path="/mcp/servers" element={<Navigate to="/mcp/servers/enterprise" replace />} />
        <Route
          path="/mcp/servers/enterprise"
          element={
            <SuspendedRoute>
              <McpEnterpriseServersPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/mcp/servers/department"
          element={
            <SuspendedRoute>
              <McpDepartmentServersPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/mcp/policy"
          element={
            <SuspendedRoute>
              <McpPolicyPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/mcp/audit-log"
          element={
            <SuspendedRoute>
              <McpAuditLogPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/mcp/approvals"
          element={
            <SuspendedRoute>
              <McpApprovalsPage />
            </SuspendedRoute>
          }
        />
        <Route
          path="/mcp/templates"
          element={
            <SuspendedRoute>
              <McpTemplatesPage />
            </SuspendedRoute>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
