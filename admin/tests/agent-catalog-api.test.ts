import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createAgentCatalogApi, type CatalogSource, type ImportCandidate } from '../lib/api/agent-catalog'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
test('catalog pages transmit global filters and mutations retain optimistic revisions', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  globalThis.fetch = (async (url, init) => {
    calls.push({ path: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    return Response.json({ success: true, data: { items: [], next_cursor: null } })
  }) as typeof fetch
  const api = createAgentCatalogApi()
  await api.sources('cursor', { search: 'name & scope', protocol: 'a2a/0.3.0', warning: 'true', capability: 'resume' })
  const url = new URL(calls[0].path, 'http://test')
  assert.equal(url.searchParams.get('search'), 'name & scope')
  assert.equal(url.searchParams.get('after'), 'cursor')
  assert.equal(url.searchParams.get('capability'), 'resume')
  await api.sync({ id: 'source-a', revision: 7 } as CatalogSource, true, 'Renew review explicitly')
  assert.deepEqual(calls[1].body, { revision: 7, renew: true, note: 'Renew review explicitly' })
  await api.decide({ id: 'candidate-a', revision: 3 } as ImportCandidate, 'abandon', 'Unconfirmed remote publication')
  assert.deepEqual(calls[2].body, { revision: 3, action: 'abandon', note: 'Unconfirmed remote publication', review_days: 7 })
  await api.runs('agent-a')
  assert.equal(new URL(calls[3].path, 'http://test').pathname, '/api/v1/external-agents/admin/catalog/agents/agent-a/runs')
})

test('organization-change cancellation rejects a late catalog response', async () => {
  const controller = new AbortController()
  globalThis.fetch = (async () => { controller.abort(); return Response.json({ success: true, data: { items: [{ org_id: 'old-org' }] } }) }) as typeof fetch
  await assert.rejects(createAgentCatalogApi(() => controller.signal).sources())
})

test('managed agent lookup batches bounded pages and merges the results', async () => {
  const counts: number[] = []
  globalThis.fetch = (async (url) => {
    const ids = new URL(String(url), 'http://test').searchParams.get('ids')!.split(',')
    counts.push(ids.length)
    return Response.json({ success: true, data: ids.map(id => ({ catalog_id: id })) })
  }) as typeof fetch
  const api = createAgentCatalogApi()
  assert.deepEqual(await api.managed([]), [])
  const ids = Array.from({ length: 205 }, (_, index) => `agent-${index}`)
  assert.deepEqual((await api.managed(ids)).map(source => source.catalog_id), ids)
  assert.deepEqual(counts, [100, 100, 5])
})

test('entry query preserves every catalog filter and event cursor', async()=>{
 const urls:string[]=[]
 globalThis.fetch=(async(url)=>{urls.push(String(url));return Response.json({success:true,data:{items:[],next_cursor:null}})}) as typeof fetch
 const api=createAgentCatalogApi(),query={provider:'a2a',status:'active',approval_status:'approved',source_state:'enabled',zone:'unassigned',owner:'org admin',execution_mode:'external_hosted',observability:'partial',capability:'cancel',warning:'true',drift:'true'}
 await api.entries('page-two',query)
 const url=new URL(urls[0],'http://test')
 for(const [key,value] of Object.entries(query))assert.equal(url.searchParams.get(key),value)
 assert.equal(url.searchParams.get('after'),'page-two')
 await api.runEvents('agent-a','task-b',100)
 assert.equal(new URL(urls[1],'http://test').pathname,'/api/v1/external-agents/admin/catalog/agents/agent-a/runs/task-b/events')
 assert.equal(new URL(urls[1],'http://test').searchParams.get('cursor'),'100')
})
test('summary lookup chunks and cancellation never returns a stale organization',async()=>{
 const counts:number[]=[]
 globalThis.fetch=(async(url)=>{const ids=new URL(String(url),'http://test').searchParams.get('ids')!.split(',');counts.push(ids.length);return Response.json({success:true,data:ids.map(catalog_id=>({catalog_id}))})}) as typeof fetch
 const ids=Array.from({length:201},(_,i)=>`a-${i}`)
 assert.deepEqual((await createAgentCatalogApi().summaries(ids)).map(e=>e.catalog_id),ids);assert.deepEqual(counts,[100,100,1])
 const abort=new AbortController()
 globalThis.fetch=(async()=>{abort.abort();return Response.json({success:true,data:[]})}) as typeof fetch
 await assert.rejects(createAgentCatalogApi(()=>abort.signal).summaries(['a']))
})
