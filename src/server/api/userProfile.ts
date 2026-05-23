import { AuthContext } from '../auth/token.js'
import { AuthService } from '../auth/service.js'
import { DirectConnectStore } from '../db.js'
import { loadBudgetStats } from '../budgetStats.js'

export async function getUserProfile(
  auth: AuthContext,
  authService: AuthService,
  db: DirectConnectStore,
) {
  const me = authService.getMe(auth)
  const user = me.user

  let departmentName = 'Unknown'
  if (user && user.departmentId) {
    departmentName = (authService as any).db.getDepartmentName(user.departmentId) || 'Unknown'
  }

  const roles = authService.listRoles().roles
  const roleName = roles.find(r => r.id === me.role)?.name || me.role

  const sessions = db.listUserSessions(auth.orgId, auth.userId)
  const stats = await loadBudgetStats(sessions)

  return {
    success: true,
    data: {
      username: user?.name || 'Unknown',
      department: departmentName,
      role: roleName,
      usage: {
        input_tokens: stats.summary.inputTokens,
        output_tokens: stats.summary.outputTokens,
        total_tokens: stats.summary.totalTokens,
        session_count: stats.summary.sessionCount,
      },
    },
  }
}
