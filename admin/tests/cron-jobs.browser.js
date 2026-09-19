// Browser regression: build Admin, copy this file to admin/dist/cron-jobs.browser.js,
// then run import('/admin/cron-jobs.browser.js').then(m => m.default()) via preview_eval
// in the logged-in, isolated moss-admin-ui-verification preview (43128).
// Remove the temporary dist copy afterwards. No extra test dependencies are needed.
export default async function runCronJobsRegression() {
  if (location.hostname !== 'localhost' || location.port !== '43128') {
    throw new Error('Run only against the isolated localhost:43128 preview')
  }
  const originalFetch = window.fetch
  const originalPath = location.pathname + location.search
  const checks = []
  const writes = []
  const pending = new Set()
  const jobs = ['a', 'b'].map(key => ({
    id: `ui-cron-${key}`, orgId: 'ui-org', userId: 'ui-user', userName: 'UI User',
    coOwnerIds: [], executorUserId: 'ui-user', name: `UI Regression ${key}`,
    enabled: false, schedule: { kind: 'cron', value: '0 0 1 1 *' },
    payloadMessage: 'Fixture only; never execute', conversationMode: 'new',
    runCount: 0, retryCount: 0, maxRetries: 0, createdAt: Date.now(),
    updatedAt: Date.now(), nextRunAt: null, lastRunAt: null, lastStatus: null,
  }))
  const response = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
  const success = () => response({ success: true })
  const failure = () => response({ success: false, message: 'UI mutation rejected' })
  const httpFailure = () => response({ message: 'UI HTTP failure' }, 503)
  let patch = failure
  let runs = () => response({ success: true, data: [] })
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    const finish = value => { pending.delete(finish); resolve(value) }
    pending.add(finish)
    return { promise, resolve: finish }
  }
  const delay = () => new Promise(done => setTimeout(done, 30))
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 8000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
      await delay()
    }
  }
  const assert = (value, message) => { if (!value) throw new Error(message) }
  const check = (name, value) => { assert(value, name); checks.push(name) }
  const navigate = path => {
    history.pushState(null, '', path)
    dispatchEvent(new PopStateEvent('popstate'))
  }
  const toggle = (key, enabled) => document.querySelector(
    `[aria-label="${enabled ? '禁用' : '启用'}任务 UI Regression ${key}"]`,
  )
  const dialog = () => document.querySelector('[role="dialog"]')
  const text = () => dialog()?.textContent || ''
  const loading = () => dialog()?.querySelector('[role="status"]')
  let previousToasts = new Set()
  const newToasts = type => [...document.querySelectorAll(`[data-sonner-toast][data-type="${type}"]`)]
    .filter(element => !previousToasts.has(element))
  const errors = () => newToasts('error').length
  const successes = () => newToasts('success').length
  const captureToasts = async () => {
    previousToasts = new Set(document.querySelectorAll('[data-sonner-toast]'))
  }
  const close = async () => {
    dialog()?.querySelector('[data-slot="dialog-close"]')?.click()
    await wait(() => !dialog(), 'dialog closed')
  }
  const open = async key => {
    document.querySelector(`[aria-label="查看任务 UI Regression ${key} 的执行记录"]`).click()
    await wait(() => text().includes(`执行记录 - UI Regression ${key}`), 'dialog opened')
  }
  const ready = async () => wait(() => dialog() && !loading(), 'runs settled')
  const run = key => ({
    id: `run-${key}`, jobId: `ui-cron-${key}`, orgId: 'ui-org', userId: 'ui-user',
    sessionId: null, status: 'ok', createdAt: Date.now(), startedAt: Date.now(),
    finishedAt: Date.now(), summary: `UNIQUE RUN FROM JOB ${key.toUpperCase()}`, error: null,
  })
  const runResponse = key => response({ success: true, data: [run(key)] })
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin)
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'GET' && ['/api/v1/admin/cron/jobs', '/api/v1/cron/jobs'].includes(url.pathname)) {
      return response({ success: true, data: jobs })
    }
    const match = url.pathname.match(/^\/api\/v1\/cron\/jobs\/ui-cron-([ab])(\/runs)?$/)
    if (match?.[2] && method === 'GET') {
      assert(url.searchParams.get('limit') === '50', 'preserve runs limit')
      return runs(match[1])
    }
    if (match && !match[2] && method === 'PATCH') {
      const body = JSON.parse(init.body)
      assert(Object.keys(body).length === 1 && typeof body.enabled === 'boolean', 'preserve PATCH payload')
      writes.push({ key: match[1], body })
      return patch(match[1], body)
    }
    // Never forward mutations or unmatched cron requests to a real service.
    if (method !== 'GET' || url.pathname.includes('/cron/')) {
      throw new Error(`Unexpected request blocked: ${method} ${url.pathname}`)
    }
    return originalFetch.call(window, input, init)
  }
  try {
    navigate('/admin/cron')
    await wait(() => toggle('a', false) && toggle('b', false), 'fixture jobs')
    for (const enabled of [false, true]) {
      for (const [name, reject] of [
        ['business failure', failure], ['HTTP failure', httpFailure],
        ['network failure', () => { throw new Error('UI network failure') }],
        ['missing error message', () => response({ success: false })],
      ]) {
        await captureToasts()
        patch = reject
        toggle('a', enabled).click()
        await wait(() => errors() > 0 && !toggle('a', enabled)?.disabled, name)
        check(`${enabled ? 'disable' : 'enable'} ${name} preserves state and never reports success`,
          !!toggle('a', enabled) && successes() === 0)
      }
      await captureToasts()
      patch = success
      toggle('a', enabled).click()
      await wait(() => toggle('a', !enabled) && successes() > 0, 'successful toggle')
      check(`${enabled ? 'disable' : 'enable'} success updates state`, true)
    }
    await captureToasts()
    const aToggle = deferred()
    const bToggle = deferred()
    patch = key => key === 'a' ? aToggle.promise : bToggle.promise
    const before = writes.length
    toggle('a', false).click()
    toggle('a', false).click()
    toggle('b', false).click()
    await wait(() => writes.length === before + 2, 'parallel toggles')
    check('duplicate clicks are blocked per task', writes.length === before + 2)
    bToggle.resolve(success())
    await wait(() => toggle('b', true), 'B toggled first')
    check('other pending task stays busy', toggle('a', false).disabled)
    aToggle.resolve(success())
    await wait(() => toggle('a', true), 'A toggled second')
    check('concurrent successful toggles both survive', !!toggle('a', true) && !!toggle('b', true))

    runs = key => runResponse(key)
    await open('a'); await ready()
    check('task A displays its own runs', text().includes('UNIQUE RUN FROM JOB A'))
    await close()
    for (const [name, reject] of [
      ['HTTP failure', httpFailure],
      ['business failure', () => response({ success: false, message: 'UI runs rejected' })],
      ['network failure', () => { throw new Error('UI runs network failure') }],
    ]) {
      runs = reject
      await open('b'); await ready()
      check(`task B ${name} shows error, not A or empty success`,
        text().includes('无法加载执行记录') && !text().includes('UNIQUE RUN FROM JOB A') && !text().includes('暂无执行记录'))
      runs = () => response({ success: true, data: [] })
      dialog().querySelector('[role="alert"] button').click()
      await wait(() => text().includes('暂无执行记录'), 'empty retry')
      check(`${name} retry distinguishes genuine empty results`, !dialog().querySelector('[role="alert"]'))
      await close()
    }
    runs = () => response({ success: false, message: 'UI runs rejected' })
    await open('b'); await ready()
    runs = key => response({ success: true, data: [{ ...run(key), sessionId: 'ui-session', session: { title: 'Fixture session' } }] })
    dialog().querySelector('[role="alert"] button').click()
    await wait(() => text().includes('UNIQUE RUN FROM JOB B'), 'successful retry')
    check('retry displays current task and preserves session links',
      dialog().querySelector('a')?.getAttribute('href') === '/admin/sessions/ui-session')
    await close()

    for (const outcome of ['success', 'business failure', 'HTTP failure']) {
      const old = deferred()
      const current = deferred()
      runs = key => key === 'a' ? old.promise : current.promise
      await open('a'); await close(); await open('b')
      old.resolve(outcome === 'success' ? runResponse('a') : outcome === 'HTTP failure'
        ? httpFailure() : response({ success: false, message: 'STALE ERROR' }))
      await delay(); await delay()
      check(`stale ${outcome} cannot clear current loading or add data/errors`,
        !!loading() && !text().includes('UNIQUE RUN') && !text().includes('STALE ERROR'))
      current.resolve(runResponse('b')); await ready()
      check(`current task survives stale ${outcome}`, text().includes('UNIQUE RUN FROM JOB B') && !text().includes('UNIQUE RUN FROM JOB A'))
      await close()
    }
    const slow = deferred()
    runs = () => slow.promise
    await open('a'); await close()
    runs = () => runResponse('b')
    await open('b'); await ready()
    slow.resolve(runResponse('a'))
    await delay(); await delay()
    check('late success cannot overwrite already loaded B', text().includes('UNIQUE RUN FROM JOB B') && !text().includes('UNIQUE RUN FROM JOB A'))
    await close()

    const previousOpen = deferred()
    runs = () => previousOpen.promise
    await open('a'); await close()
    runs = () => response({ success: true, data: [] })
    await open('a'); await ready()
    previousOpen.resolve(runResponse('a')); await delay(); await delay()
    check('reopening the same task invalidates its earlier request', text().includes('暂无执行记录') && !text().includes('UNIQUE RUN'))
    await close()

    const unmounted = deferred()
    runs = () => unmounted.promise
    await open('a')
    navigate('/admin/users')
    await wait(() => !toggle('a', true) && !dialog(), 'page unmounted')
    unmounted.resolve(response({ success: false, message: 'STALE UNMOUNT ERROR' }))
    navigate('/admin/cron')
    await wait(() => toggle('a', false), 'page remounted')
    runs = () => response({ success: true, data: [] })
    await open('b'); await ready()
    check('unmounted request cannot affect the remounted page', text().includes('暂无执行记录') && !document.body.textContent.includes('STALE UNMOUNT ERROR'))
    await close()
    return { passed: checks.length, checks, mockedWrites: writes.length, realWrites: 0 }
  } catch (error) {
    throw new Error(`${error.message}\nPassed ${checks.length}: ${checks.join('; ')}`)
  } finally {
    for (const finish of pending) finish(response({ success: true, data: [] }))
    if (dialog()) await close()
    window.fetch = originalFetch
    // Unmount fixture state even when the original page was also Cron.
    navigate('/admin')
    await wait(() => !toggle('a', false) && !toggle('a', true), 'fixture cleanup')
    if (originalPath !== '/admin') navigate(originalPath)
  }
}
