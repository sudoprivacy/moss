import { expect, test } from 'bun:test'
import { primaryNavGroups } from '../components/app-sidebar'
import { hasScope } from '../lib/api/client'

test('every primary destination appears exactly once after Agent and Zone entries', () => {
  const routes = primaryNavGroups.flatMap(group => group.items.map(item => item.url))
  expect(routes).toHaveLength(17)
  expect(new Set(routes).size).toBe(routes.length)
  expect([...routes].sort()).toEqual([
    '/', '/budget', '/users', '/agents', '/zones', '/sessions', '/cabin/conversations',
    '/cron', '/event-triggers', '/channels', '/corp-apps', '/settings/agents',
    '/settings/skill', '/document-center', '/secrets', '/operations', '/mcp',
  ].sort())
})

test('operations and tools retain their destinations and authorization gates', () => {
  const operations = primaryNavGroups.find(group => group.id === 'operations')!
  expect(operations.items.map(item => item.url)).toEqual(['/event-triggers', '/operations', '/mcp'])
  const center = operations.items.find(item => item.url === '/operations')!
  expect(center.requiredScope).toBe('admin:settings')
  expect(center.children?.map(item => item.url)).toContain('/operations/billing')
  expect(operations.items.find(item => item.url === '/mcp')?.requiredScope).toBe('admin:mcp')
  expect(hasScope([], center.requiredScope!)).toBe(false)
  expect(hasScope(['sessions:list'], center.requiredScope!)).toBe(false)
  expect(hasScope(['admin:settings'], center.requiredScope!)).toBe(true)
  expect(hasScope(['*'], center.requiredScope!)).toBe(true)
})

test('new Agent and Zone entries stay in the workspace without shifting organization items', () => {
  const workspace = primaryNavGroups.find(group => group.id === 'workspace')!
  expect(workspace.items.map(item => item.url)).toContain('/agents')
  expect(workspace.items.map(item => item.url)).toContain('/zones')
  const organization = primaryNavGroups.find(group => group.id === 'organization')!
  expect(organization.items.map(item => item.url)).toEqual(['/users', '/channels', '/corp-apps', '/secrets'])
})
