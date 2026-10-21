import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { HostedEvaluationCoordinator } from './hostedEvaluationCoordinator.js'
import { AgentInventoryService } from './inventoryService.js'
import { dispatchAgentInventory } from './inventoryRoutes.js'
import { ExternalProviderError } from '../externalProviders/policy.js'

function fixture() {
  const events: string[] = [], completions: any[] = []
  const run: any = { id: 'run-a', asset_id: 'asset-a', artifact_id: 'artifact-a', dataset_id: 'dataset-a', metadata_digest: 'metadata', spec_digest: 'spec', dataset_digest: 'dataset', rubric_digest: 'rubric', initiated_by: 'alice', total_cases: 1, timeout_seconds: 120, max_model_calls: 1, status: 'queued', running_cases: 0 }
  const artifact: any = { id: 'artifact-a', asset_id: 'asset-a', metadata_digest: 'metadata', spec_digest: 'spec', image: {model_resource: 'model:lab', model_name: 'model'} }
  let claimed = false
  const registry: any = {
    hostedGet: async () => artifact,
    evaluationDatasetGet: async () => ({ asset_id: 'asset-a', metadata_digest: 'metadata', dataset_digest: 'dataset', rubric_digest: 'rubric', dataset: {cases: [{id: 'one', query: '6*7', expected: '42'}]} }),
    evaluationStart: async () => run,
    evaluationGet: async () => run,
    evaluationClaim: async () => { events.push('claim'); if (claimed) return null; claimed = true; return { case: {id: 'case-a', sample_id: 'one', deadline_at: Date.now()+120000}, lease_token: 'one-time-lease' } },
    evaluationGrant: async () => { events.push('grant'); return {api_key: 'one-time-key', grant: {id:'grant-a', request: {asset_id:'asset-a',task_id:'case-a',mode:'evaluation',spec_digest:'spec',metadata_digest:'metadata',dataset_digest:'dataset',initiated_by:'alice',max_model_calls:1,permissions:[{operation:'model.invoke',resource:'model:lab'}]}}} },
    executionRevoke: async () => { events.push('revoke') },
    evaluationComplete: async (_org: string, _id: string, result: any) => { events.push('complete'); completions.push(result); return result },
    evaluationStop: async () => { events.push('stop'); return run },
  }
  const gateway: any = {
    invoke: async () => {events.push('model'); return {id:'call-a',status:'completed',answer:'42'}},
    taskCalls: async () => [{id:'call-a'}],
    reconcile: async () => {events.push('model-cleanup'); return {tokenCleanupPending:false}},
  }
  const runner: any = {run: async (options: any) => {events.push('runner'); await options.trace({node:'llm',phase:'completed',origin:'worker_reported'}); return {answer:await options.model(1,{messages:[],max_tokens:128}),modelCalls:1}}}
  const coordinator = new HostedEvaluationCoordinator(registry, gateway, runner, () => true)
  const admit = async () => {events.push('admit')}
  async function finished() {for(let i=0; !completions.length && i<100; i++) await delay(10); assert.equal(completions.length,1)}
  return {registry,run,gateway,runner,events,completions,coordinator,admit,finished}
}

test('durable claim precedes IAM/model, completion contains trace and never contains key', async () => {
  const f = fixture()
  await f.coordinator.resume('org-a','run-a',f.admit)
  await f.finished()
  assert.ok(f.events.indexOf('claim') < f.events.indexOf('grant'))
  assert.ok(f.events.indexOf('grant') < f.events.indexOf('runner'))
  assert.ok(f.events.indexOf('model-cleanup') < f.events.indexOf('revoke'))
  assert.ok(f.events.indexOf('revoke') < f.events.indexOf('complete'))
  assert.equal(f.completions[0].status,'succeeded')
  assert.equal(f.completions[0].cleanup_confirmed,true)
  assert.deepEqual(f.completions[0].model_call_ids,['call-a'])
  assert.equal(f.completions[0].trace[0].origin,'worker_reported')
  assert.ok(!JSON.stringify(f.completions).includes('one-time-key'))
  await f.coordinator.close()
})

test('lost one-time IAM key does not execute a second worker', async () => {
  const f=fixture(), original=f.registry.evaluationGrant
  f.registry.evaluationGrant=async()=>({...await original(),api_key:null})
  await f.coordinator.resume('org-a','run-a',f.admit); await f.finished()
  assert.ok(!f.events.includes('runner'))
  assert.equal(f.completions[0].status,'failed')
  assert.equal(f.completions[0].error_code,'EVALUATION_CREDENTIAL_UNAVAILABLE')
  assert.ok(f.events.includes('revoke'))
  await f.coordinator.close()
})

test('model cleanup outage still revokes IAM and cannot report success', async () => {
  const f=fixture()
  f.gateway.reconcile=async()=>{throw new Error('private provider details')}
  await f.coordinator.resume('org-a','run-a',f.admit);await f.finished()
  assert.equal(f.completions[0].status,'unknown')
  assert.equal(f.completions[0].cleanup_confirmed,false)
  assert.equal(f.completions[0].answer,null)
  assert.ok(f.events.includes('revoke'))
  assert.ok(!JSON.stringify(f.completions).includes('private provider'))
  await f.coordinator.close()
})

test('worker termination remains unknown and blocks next local case', async () => {
  const f=fixture()
  f.runner.run=async()=>{throw new Error('worker died')}
  await f.coordinator.resume('org-a','run-a',f.admit);await f.finished()
  assert.equal(f.completions[0].status,'unknown')
  assert.equal(f.completions[0].cleanup_confirmed,false)
  assert.equal(f.events.filter(x=>x==='claim').length,1)
  await f.coordinator.close()
})

test('restart cannot execute a durably running case; malformed artifact cannot dispatch', async () => {
  const f=fixture();f.run.running_cases=1
  await assert.rejects(f.coordinator.resume('org-a','run-a',f.admit),{code:'EVALUATION_CASE_IN_PROGRESS'})
  assert.ok(!f.events.includes('claim'))
  f.run.running_cases=0; f.run.spec_digest='different'
  await assert.rejects(f.coordinator.resume('org-a','run-a',f.admit),{code:'EVALUATION_INPUT_MISMATCH'})
  assert.ok(!f.events.includes('claim')); await f.coordinator.close()
})

test('concurrent resume claims only one local execution slot', async () => {
  const f=fixture()
  await Promise.all(Array.from({length:8},()=>f.coordinator.resume('org-a','run-a',f.admit)))
  await f.finished()
  assert.equal(f.events.filter(x=>x==='runner').length,1)
  await f.coordinator.close()
})

test('manager boundary blocks caller scores, forged actor, lease and owner writes', async () => {
  const actor:any={orgId:'org-a',userId:'alice',role:'admin',scopes:[]}
  let manage=true, starts:any[]=[]
  const service=new AgentInventoryService({
    registry:{scope:()=>({}),inventoryGet:async()=>({id:'asset-a',metadata_digest:'metadata',metadata:{owner_user_id:'alice'}})} as any,
    hosted:{start:async (_org:string, command:any)=>{starts.push(command);return {id:'run-a'}}} as any,
    catalog:{} as any,authorize:async()=>({canManage:manage}), member:async()=>({id:'alice',departmentId:null}), members:async()=>[],labels:async()=>({users:new Map(),departments:new Map()}),
  })
  const body={asset_id:'asset-a',metadata_digest:'metadata',artifact_id:'artifact-a',dataset_id:'dataset-a',request_id:'request-1'}
  const url=new URL('http://local/api/v1/agent-inventory/hosted/evaluations')
  for(const patch of [{passed_cases:1},{initiated_by:'other'},{lease_token:'secret'},{status:'succeeded'}]) {
    const result=await dispatchAgentInventory(service,actor,'POST',url,{...body,...patch})
    assert.equal(result.status,400)
  }
  assert.equal(starts.length,0)
  manage=false
  assert.equal((await dispatchAgentInventory(service,actor,'POST',url,body)).status,403)
  manage=true
  assert.equal((await dispatchAgentInventory(service,actor,'POST',url,body)).status,200)
  assert.equal(starts[0].initiated_by,'alice')
  const forbidden=new URL(url+'/run-a/complete')
  assert.equal((await dispatchAgentInventory(service,actor,'POST',forbidden,{})).status,404)
})

test('evaluation detail and case reads require current owner or manager without mutation', async () => {
  let manage=false, owner='alice', mutations=0
  const run={id:'run-a',asset_id:'asset-a'}
  const service=new AgentInventoryService({
    registry:{scope:()=>({}),inventoryGet:async()=>({id:'asset-a',metadata:{owner_user_id:owner}}),evaluationGet:async()=>run,evaluationCases:async()=>({items:[],next_cursor:null})} as any,
    hosted:{start:async()=>{mutations++}} as any,catalog:{} as any,
    authorize:async()=>({canManage:manage}),member:async()=>({id:'alice',departmentId:null}),members:async()=>[],labels:async()=>({users:new Map(),departments:new Map()}),
  })
  const actor:any={orgId:'org-a',userId:'alice',role:'member',scopes:[]}
  for(const suffix of ['', '/cases']){
    const url=new URL('http://local/api/v1/agent-inventory/hosted/evaluations/run-a'+suffix)
    owner='alice';assert.equal((await dispatchAgentInventory(service,actor,'GET',url,undefined)).status,200)
    owner='bob';assert.equal((await dispatchAgentInventory(service,actor,'GET',url,undefined)).status,404)
    manage=true;assert.equal((await dispatchAgentInventory(service,actor,'GET',url,undefined)).status,200);manage=false
  }
  assert.equal(mutations,0)
})
