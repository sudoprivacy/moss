import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { ProductRegistryClient, type RegistryRequest } from './registryClient.js'
import { AgentInventoryService } from './inventoryService.js'
import { dispatchAgentInventory } from './inventoryRoutes.js'
import { stableJson } from './provider/protocol.js'
import fixture from '../../../contracts/agent-registry/v1alpha1/signed-version.fixture.json' with { type: 'json' }
import type { EvaluationDataset } from '../../../contracts/agent-registry/v1alpha1/contract.gen.js'
import type { AuthContext } from '../auth/token.js'
const hash=(v:unknown)=>'sha256:'+createHash('sha256').update(stableJson(v)).digest('hex')
const rubric={id:'exact-strip-v1',comparison:'strip-leading-trailing-ASCII-whitespace-U0009-U000D-U0020-exact-case-sensitive',denominator:'all-cases-including-errors',aggregation:'passed-cases/total-cases'}
function record():EvaluationDataset{
 const dataset={name:'算术评测',version:'1',input_scope:'synthetic_text' as const,rubric:'exact-strip-v1' as const,cases:[{id:'case-1',query:'6 * 7',expected:'42'}]}
 return {api_version:'agent-registry.sudo.dev/v1alpha1',kind:'EvaluationDataset',id:'dataset-a',zone:'zone-a',asset_id:'asset-a',metadata_digest:hash('metadata'),dataset_digest:hash(dataset),rubric_digest:hash(rubric),dataset,created_by:'user:admin',initiated_by:'admin',created_at:1000}
}
function client(request:RegistryRequest){return new ProductRegistryClient({endpoint:'http://127.0.0.1:12345',token:'synthetic-management-token',publicKeys:[fixture.public_key_pem],organizations:{'org-a':{trustDomain:'a.example',zoneId:'zone-a'}},request})}
void test('dataset SDK binds content, rubric, asset, organization and pagination to owner response',async()=>{
 let value:any=record();const registry=client(async()=>Response.json(value))
 assert.deepEqual(await registry.evaluationDatasetGet('org-a','dataset-a'),record())
 for(const patch of [{zone:'foreign'},{id:'other'},{dataset_digest:hash('forged')},{rubric_digest:hash('forged')},{dataset:{...record().dataset,cases:[...record().dataset.cases,...record().dataset.cases]}}]){
  value={...record(),...patch};await assert.rejects(registry.evaluationDatasetGet('org-a','dataset-a'),{code:'EVALUATION_RESPONSE_INVALID'})
 }
 value={kind:'EvaluationDatasetPage',items:[record()],next_cursor:null}
 assert.equal((await registry.evaluationDatasetList('org-a','asset-a')).items.length,1)
 await assert.rejects(registry.evaluationDatasetList('org-a','foreign-asset'),{code:'EVALUATION_RESPONSE_INVALID'})
 value.next_cursor='other';await assert.rejects(registry.evaluationDatasetList('org-a','asset-a'),{code:'EVALUATION_RESPONSE_INVALID'})
})
void test('registration rejects unsupported grading and returned content drift',async()=>{
 let value:any=record(),calls=0;const registry=client(async()=>{calls++;return Response.json(value)})
 const command={request_id:'request-123',asset_id:'asset-a',metadata_digest:record().metadata_digest,initiated_by:'admin',dataset:record().dataset}
 assert.deepEqual(await registry.evaluationDatasetRegister('org-a',command),record())
 await assert.rejects(registry.evaluationDatasetRegister('org-a',{...command,dataset:{...command.dataset,rubric:'run-code' as never}}),{code:'INVALID_EVALUATION_DATASET'})
 assert.equal(calls,1)
 value={...record(),metadata_digest:hash('changed')};await assert.rejects(registry.evaluationDatasetRegister('org-a',command),{code:'EVALUATION_RESPONSE_INVALID'})
})
void test('Moss dataset routes enforce manager writes, owner reads and server-selected actor',async()=>{
 let canManage=false,calls=0,submitted:any
 const registry={scope(){},inventoryGet:async()=>({id:'asset-a',metadata_digest:hash('metadata'),metadata:{owner_user_id:'owner'}}),evaluationDatasetList:async(_org:string,id:string)=>{assert.equal(id,'asset-a');calls++;return{items:[]}},evaluationDatasetRegister:async(_org:string,body:any)=>{submitted=body;return record()}}
 const service=new AgentInventoryService({registry:registry as never,catalog:{} as never,authorize:async()=>({canManage}),member:async()=>({id:'owner',departmentId:null}),members:async()=>[],labels:async()=>({users:new Map(),departments:new Map()})})
 const actor={userId:'owner',orgId:'org-a'} as AuthContext
 const list=new URL('http://localhost/api/v1/agent-inventory/assets/asset-a/datasets')
 assert.equal((await dispatchAgentInventory(service,actor,'GET',list,undefined)).status,200)
 assert.equal(calls,1)
 assert.equal((await dispatchAgentInventory(service,{...actor,userId:'foreign'},'GET',list,undefined)).status,404)
 const write=new URL('http://localhost/api/v1/agent-inventory/hosted/datasets')
 const body={request_id:'request-123',asset_id:'asset-a',metadata_digest:hash('metadata'),dataset:record().dataset}
 assert.equal((await dispatchAgentInventory(service,actor,'POST',write,body)).status,403)
 canManage=true
 assert.equal((await dispatchAgentInventory(service,actor,'POST',write,body)).status,200)
 assert.equal(submitted.initiated_by,'owner')
 assert.equal((await dispatchAgentInventory(service,actor,'POST',write,{...body,initiated_by:'forged'})).status,400)
})

void test('dataset version errors survive the owner gateway without leaking response bodies',async()=>{
 const registry=client(async()=>Response.json({detail:{code:'EVALUATION_VERSION_CONFLICT',secret:'must-not-forward'}},{status:409}))
 await assert.rejects(registry.evaluationDatasetRegister('org-a',{request_id:'request-123',asset_id:'asset-a',metadata_digest:record().metadata_digest,initiated_by:'admin',dataset:record().dataset}),error=>error instanceof Error && error.message==='EVALUATION_VERSION_CONFLICT')
})
