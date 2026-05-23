import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { DashboardShell } from './layouts/dashboard-shell'

const LoginPage = lazy(() => import('./pages/login-page'))
const DashboardPage = lazy(() => import('./pages/dashboard-page'))
const BudgetPage = lazy(() => import('./pages/budget-page'))
const SessionsPage = lazy(() => import('./pages/sessions-page'))
const UsersPage = lazy(() => import('./pages/users-page'))
const ApiKeysPage = lazy(() => import('./pages/api-keys-page'))
const SystemSettingsPage = lazy(() => import('./pages/system-settings-page'))
const AdapterSettingsPage = lazy(() => import('./pages/adapter-settings-page'))
const SkillStorePage = lazy(() => import('./pages/skill-store-page'))
const AgentHubPage = lazy(() => import('./pages/agent-hub-page'))
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
          path="/settings/adapters"
          element={
            <SuspendedRoute>
              <AdapterSettingsPage />
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
