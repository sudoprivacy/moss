export interface RegisteredRoute {
  method: string
  path: string
}

export interface RouteInventoryDifference {
  missing: string[]
  unapproved: string[]
}

export const APPROVED_ADDITIONAL_SUDOWORK_ROUTES = new Set([
  'GET /api/assistants/cursor',
  'GET /api/assistants/:assistantId',
  'POST /api/assistants',
  'GET /api/skills',
  'GET /api/skills/:skillId',
  'POST /api/skills',
  'GET /api/categories',
  'GET /api/catalog/artifacts/:kind/:resourceId',
  'GET /uploads/config-items/:filename',
  'GET /uploads/enterprises/:filename',
])

export function routeKey(route: RegisteredRoute): string {
  return `${route.method.toUpperCase()} ${route.path}`
}

export function compareSudoworkRouteInventory(
  expectedRoutes: readonly RegisteredRoute[],
  actualRoutes: readonly RegisteredRoute[],
  approvedAdditionalRoutes = APPROVED_ADDITIONAL_SUDOWORK_ROUTES,
): RouteInventoryDifference {
  const expected = new Set(expectedRoutes.map(routeKey))
  const actual = new Set(actualRoutes
    .filter(route => route.method.toUpperCase() !== 'ALL')
    .map(routeKey))
  return {
    missing: [...expected].filter(route => !actual.has(route)).sort(),
    unapproved: [...actual]
      .filter(route => !expected.has(route) && !approvedAdditionalRoutes.has(route))
      .sort(),
  }
}

function compilePath(path: string): RegExp {
  const source = path
    .split('/')
    .map(segment => {
      if (segment === '*') return '.*'
      if (segment.startsWith(':')) return '[^/]+'
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return new RegExp(`^${source}/?$`)
}

export function createCompatibilityRouteMatcher(
  routes: readonly RegisteredRoute[],
): (method: string | undefined, pathname: string) => boolean {
  const compiled = routes
    .filter(route => route.method.toUpperCase() !== 'ALL' && route.path !== '*')
    .map(route => ({ method: route.method.toUpperCase(), pattern: compilePath(route.path) }))
  return (method, pathname) => {
    const normalizedMethod = (method ?? 'GET').toUpperCase()
    return compiled.some(route =>
      (route.method === normalizedMethod || (normalizedMethod === 'HEAD' && route.method === 'GET'))
      && route.pattern.test(pathname),
    )
  }
}
