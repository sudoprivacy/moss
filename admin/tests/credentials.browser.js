// Build Admin and copy this file to admin/dist/credentials.browser.js, then run
// import('/admin/credentials.browser.js').then(m => m.default()) via preview_eval.
// Only the logged-in isolated localhost:43128 preview is allowed. All mutations
// are mocked; unmatched mutations and individual-secret reads are blocked.
export default async function runCredentialRegression() {
  if (location.hostname !== 'localhost' || location.port !== '43128') throw new Error('Isolated preview required')
  const originalFetch = window.fetch
  const originalPath = location.pathname + location.search
  const checks = [], writes = [], reads = [], pending = new Set()
  const items = Array.from({ length: 21 }, (_, index) => ({
    id: 9000 + index, name: `UI metadata ${index + 1}`, pinyin: `ui_metadata_${index + 1}`,
    description: 'Synthetic integration fixture', scope: 'system', status: 1,
    entries: [{ id: 9100 + index, config_key: 'token', name: 'Token', required: 1 }],
  }))
  const department = { ...items[0], id: 9200, name: 'UI department metadata', pinyin: 'ui_department', scope: 'department' }
  const records = items.filter((_, index) => index !== 1).map(item => ({
    namespace: `org:ui-org:system:${item.pinyin}`, key: 'token', enabled: false, version: 3,
  }))
  const deptRecords = [{ namespace: 'org:ui-org:role:ui_department', key: 'token', enabled: false, version: 4 }]
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  const ok = data => response({ success: true, data })
  const failure = () => response({ success: false, error: { code: 'fixture', message: 'UI rejected' } })
  let listOverride, mutationFailure = false
  const delay = () => new Promise(resolve => setTimeout(resolve, 40))
  const wait = async (predicate, label) => {
    const until = Date.now() + 8000
    while (!predicate()) { if (Date.now() > until) throw new Error(`Timeout: ${label}`); await delay() }
  }
  const check = (name, result) => { if (!result) throw new Error(name); checks.push(name) }
  const navigate = path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')) }
  const button = (text, root = document) => [...root.querySelectorAll('button')].find(el => el.textContent.trim() === text)
  const row = index => [...document.querySelectorAll('tbody tr')].find(el => el.textContent.includes(items[index].name))
  const dialog = () => document.querySelector('[role="dialog"]')
  const ready = () => document.querySelector('[aria-label="企业凭据列表"][aria-busy="false"]')
  const close = async () => { button('取消', dialog())?.click(); await wait(() => !dialog(), 'close editor') }
  const fill = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const pageData = page => ({ success: true, data: items.slice((page - 1) * 20, page * 20), total: 21, page, page_size: 20 })
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin)
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const path = url.pathname
    if (method === 'GET') {
      reads.push(path)
      if (path === '/api/v1/config-items') {
        if (url.searchParams.get('scope') === 'department') return ok([department])
        if (listOverride) return listOverride(url)
        return response(pageData(Number(url.searchParams.get('page') || 1)))
      }
      if (path === '/api/v1/secrets') return ok(records)
      if (path === '/api/v1/department-secrets') return ok(deptRecords)
      if (path === '/api/v1/secret-metadata') return ok([])
      if (path === '/api/v1/config-items/9200/authorized-departments') return ok(['ui-dept'])
      if (path.startsWith('/api/v1/secrets/')) throw new Error('Individual value read forbidden')
      return originalFetch.call(window, input, init)
    }
    if (path.startsWith('/api/v1/secret-metadata/9') || path === '/api/v1/config-items/9200/authorized-departments'
      || /^\/api\/v1\/secrets\/(system|role)%3Aui_/.test(path)) {
      const body = init?.body ? JSON.parse(init.body) : undefined
      writes.push({ path, method, body })
      if (mutationFailure) return failure()
      const namespace = decodeURIComponent(path.split('/')[4])
      const list = namespace.startsWith('role:') ? deptRecords : records
      let record = list.find(entry => entry.namespace.endsWith(namespace))
      if (method === 'PUT' && path.startsWith('/api/v1/secrets/')) {
        if (!record) { record = { namespace: `org:ui-org:${namespace}`, key: 'token', enabled: true, version: 1 }; list.push(record) }
        else record.version++
      }
      if (path.endsWith('/enable') && record) record.enabled = true
      if (path.endsWith('/disable') && record) record.enabled = false
      return ok()
    }
    throw new Error(`Unexpected mutation blocked: ${method} ${path}`)
  }
  try {
    navigate('/admin/users')
    await wait(() => !document.querySelector('[aria-label="企业凭据列表"]'), 'initial unmount')
    navigate('/admin/secrets/enterprise')
    await wait(() => ready() && row(0), 'enterprise page')
    check('first page displays 20 metadata rows', document.querySelectorAll('tbody tr').length === 20)
    check('disabled record remains saved', row(0).textContent.includes('已保存') && row(0).textContent.includes('已禁用'))
    button('编辑', row(0)).click(); await wait(dialog, 'editor')
    check('saved editor is blank and explains keep semantics', dialog().querySelector('input[type="password"]').value === '' && dialog().textContent.includes('已保存的字段留空保留原值'))
    const before = writes.length
    button('保存', dialog()).click(); await wait(() => !dialog() && ready(), 'blank save')
    check('blank saved required field writes only expiry, never credential', writes.length === before + 1 && writes.at(-1).path === '/api/v1/secret-metadata/9000')
    button('配置', row(1)).click(); await wait(dialog, 'new field editor')
    const unsetBefore = writes.length
    button('保存', dialog()).click(); await delay(); await delay()
    check('unset required field blocks blank save', !!dialog() && writes.length === unsetBefore)
    fill(dialog().querySelector('input[type="password"]'), 'synthetic-not-a-real-secret')
    await delay(); mutationFailure = true
    button('保存', dialog()).click()
    await wait(() => dialog()?.querySelector('[role="alert"]'), 'failed write')
    check('business failure retains draft and explains partial writes', dialog().querySelector('input[type="password"]').value === 'synthetic-not-a-real-secret' && dialog().textContent.includes('部分更新可能已生效'))
    mutationFailure = false
    button('保存', dialog()).click(); await wait(() => !dialog() && ready() && row(1)?.textContent.includes('已保存'), 'new save')
    check('new saved field refreshes metadata status', row(1).textContent.includes('已启用'))
    button('启用', row(0)).click(); await wait(() => ready() && row(0)?.textContent.includes('已启用'), 'enable')
    check('enable refreshes saved disabled record', row(0).textContent.includes('已保存'))
    button('禁用', row(0)).click(); await wait(() => ready() && row(0)?.textContent.includes('已禁用'), 'disable')
    check('disable retains saved status', row(0).textContent.includes('已保存'))
    button('下一页').click(); await wait(() => ready() && row(20), 'second page')
    check('second page joins metadata for item 21 only', document.querySelectorAll('tbody tr').length === 1 && row(20).textContent.includes('已保存') && button('下一页').disabled)
    listOverride = failure
    button('刷新').click(); await wait(() => document.querySelector('[role="alert"]'), 'refresh failure')
    check('same-query failure retains rows with explicit error', !!row(20) && document.body.textContent.includes('刷新企业凭据失败'))
    listOverride = undefined
    button('重新加载').click(); await wait(() => ready() && !document.querySelector('[role="alert"]'), 'refresh retry')
    check('refresh retry clears error', !!row(20))
    listOverride = failure
    button('上一页').click(); await wait(() => document.body.textContent.includes('无法加载企业凭据'), 'new page failure')
    check('failed different query never relabels old rows or shows empty success', !row(20) && !document.body.textContent.includes('暂无企业凭据配置项'))
    listOverride = undefined
    button('重新加载').click(); await wait(() => ready() && row(0), 'query retry')
    check('failed new page is retryable', document.querySelectorAll('tbody tr').length === 20)
    let resolveOld
    listOverride = () => new Promise(resolve => { resolveOld = resolve; pending.add(resolve) })
    button('刷新').click(); await wait(() => resolveOld, 'delayed list request')
    navigate('/admin/users'); await wait(() => !document.querySelector('[aria-label="企业凭据列表"]'), 'unmount')
    listOverride = undefined
    navigate('/admin/secrets/enterprise'); await wait(() => ready() && row(0), 'remount')
    resolveOld(response({ success: true, data: [], total: 0, page: 1, page_size: 20 })); pending.delete(resolveOld)
    await delay(); await delay()
    check('unmounted stale response cannot replace current metadata page', !!row(0) && document.querySelectorAll('tbody tr').length === 20)
    navigate('/admin/secrets/department')
    await wait(() => document.body.textContent.includes(department.name) && button('编辑'), 'department')
    check('department disabled record remains filled', document.body.textContent.includes('已填写') && document.body.textContent.includes('已禁用'))
    button('编辑').click(); await wait(() => dialog()?.textContent.includes('已选择 1 个部门'), 'department associations')
    const deptBefore = writes.length
    button('保存', dialog()).click(); await wait(() => !dialog(), 'department blank save')
    check('department blank required field preserves stored value', writes.length === deptBefore + 2 && writes.slice(deptBefore).every(write => !write.path.startsWith('/api/v1/secrets/')))
    check('lists and editors never fetch individual secret values', !reads.some(path => path.startsWith('/api/v1/secrets/')))
    return { passed: checks.length, checks, mockedWrites: writes.length, realWrites: 0 }
  } catch (error) {
    throw new Error(`${error.message}; passed ${checks.length}: ${checks.join('; ')}`)
  } finally {
    try {
      for (const resolve of pending) resolve(ok([]))
      if (dialog()) await close()
    } finally {
      window.fetch = originalFetch
      navigate('/admin'); await wait(() => !document.body.textContent.includes('UI metadata'), 'cleanup')
      if (originalPath !== '/admin') navigate(originalPath)
    }
  }
}
