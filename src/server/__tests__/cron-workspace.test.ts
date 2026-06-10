import { describe, expect, it } from 'bun:test'

import {
  isVisibleInUserContainer,
  resolveCronWorkspace,
} from '../services/cron/CronService.js'

describe('cron workspace resolution', () => {
  it('defaults cron sessions to a runtime-mounted per-job workspace', () => {
    expect(resolveCronWorkspace({
      jobId: 'job-1',
      runtimeDir: '/app/data/runtime',
      defaultRuntime: 'docker',
      dockerContainerMode: 'user',
    })).toBe('/app/data/runtime/cron/job-1/workspace')
  })

  it('allows explicit workspaces inside user-container mounts', () => {
    expect(resolveCronWorkspace({
      jobId: 'job-1',
      jobWorkspace: '/root/.moss/wikis/job-1',
      runtimeDir: '/app/data/runtime',
      defaultRuntime: 'docker',
      dockerContainerMode: 'user',
      mossHome: '/root/.moss',
    })).toBe('/root/.moss/wikis/job-1')

    expect(isVisibleInUserContainer(
      '/app/data/runtime/sessions/s1/workspace',
      '/app/data/runtime',
      '/root/.moss',
    )).toBe(true)
  })

  it('rejects explicit workspaces outside user-container mounts', () => {
    expect(() => resolveCronWorkspace({
      jobId: 'job-1',
      jobWorkspace: '/tmp/cron',
      runtimeDir: '/app/data/runtime',
      defaultRuntime: 'docker',
      dockerContainerMode: 'user',
      mossHome: '/root/.moss',
    })).toThrow('not mounted in docker user-container mode')
  })

  it('keeps session-container compatibility for explicit external workspaces', () => {
    expect(resolveCronWorkspace({
      jobId: 'job-1',
      jobWorkspace: '/tmp/cron',
      runtimeDir: '/app/data/runtime',
      defaultRuntime: 'docker',
      dockerContainerMode: 'session',
      mossHome: '/root/.moss',
    })).toBe('/tmp/cron')
  })
})
