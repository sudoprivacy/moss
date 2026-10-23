import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProductRegistryClient } from './registryClient.js'
import { contentDigest } from './provider/protocol.js'
import fixture from '../../../contracts/agent-registry/v1alpha1/signed-version.fixture.json' with {type:'json'}
const digest='sha256:'+'a'.repeat(64)
const record=()=>({api_version:'agent-registry.sudo.dev/v1alpha1',kind:'HostedEvaluationRun',id:'run-a',zone:'zone-a',asset_id:'asset-a',metadata_digest:digest,artifact_id:'artifact-a',spec_digest:digest,dataset_id:'dataset-a',dataset_digest:digest,rubric_digest:digest,initiated_by:'alice',created_by:'user:admin',created_at:1000,timeout_seconds:120,max_model_calls:1,total_cases:1,queued_cases:1,running_cases:0,finished_cases:0,passed_cases:0,status:'queued',evidence:'evaluation_only'})
function client(response:()=>unknown){return new ProductRegistryClient({endpoint:'http://127.0.0.1:12345',token:'test-only',publicKeys:[fixture.public_key_pem],organizations:{'org-a':{trustDomain:'a.example',zoneId:'zone-a'}},request:async()=>Response.json(response())})}
void test('evaluation response requires same zone, run, asset and consistent counters/status',async()=>{
 let value:any=record();const c=client(()=>value)
 assert.equal((await c.evaluationGet('org-a','run-a')).id,'run-a')
 for(const patch of [{zone:'zone-b'},{id:'foreign'},{total_cases:2},{passed_cases:1},{status:'finished'},{running_cases:2}]){
  value={...record(),...patch};await assert.rejects(c.evaluationGet('org-a','run-a'),{code:'EVALUATION_RESPONSE_INVALID'})
 }
 value={kind:'HostedEvaluationPage',items:[record()],next_cursor:null}
 await assert.rejects(c.evaluationList('org-a','other'),{code:'EVALUATION_RESPONSE_INVALID'})
 value.next_cursor='not-last';await assert.rejects(c.evaluationList('org-a','asset-a'),{code:'EVALUATION_RESPONSE_INVALID'})
})
void test('case response rejects forged trace, wrong run and success with pending cleanup',async()=>{
 const trace=[{node:'llm',phase:'completed',origin:'worker_reported'}]
 const row:any={api_version:'agent-registry.sudo.dev/v1alpha1',kind:'HostedEvaluationCase',id:'case-a',run_id:'run-a',sample_id:'sample-a',status:'succeeded',answer:'42',passed:true,trace,trace_digest:contentDigest(trace),cleanup_confirmed:true,iam_cleanup_confirmed:true,model_evidence:'evaluator_reported'}
 let item={...row};const c=client(()=>({kind:'HostedEvaluationCasePage',items:[item],next_cursor:null}))
 assert.equal((await c.evaluationCases('org-a','run-a')).items.length,1)
 for(const patch of [{trace_digest:digest},{run_id:'other'},{cleanup_confirmed:false},{iam_cleanup_confirmed:false},{status:'unknown'}]){
  item={...row,...patch};await assert.rejects(c.evaluationCases('org-a','run-a'),{code:'EVALUATION_RESPONSE_INVALID'})
 }
})

void test('source evaluation and policy/comparison responses preserve role, scope and integer scoring', async () => {
  const source={profile:'dify-service-api-v1',source_digest:digest,runtime_digest:digest,model_name:'model',revision_strength:'observed_source_snapshot'}
  let value:any={...record(),role:'source_baseline',source_runtime:source}
  const c=client(()=>value)
  assert.equal((await c.evaluationGet('org-a','run-a')).role,'source_baseline')
  value={...value,role:'hosted'}
  await assert.rejects(c.evaluationGet('org-a','run-a'),{code:'EVALUATION_RESPONSE_INVALID'})
  const policy={kind:'MigrationPolicy',id:'policy-a',zone:'zone-a',asset_id:'asset-a',metadata_digest:digest,artifact_id:'artifact-a',spec_digest:digest,dataset_id:'dataset-a',dataset_digest:digest,rubric_digest:digest,baseline_run_id:'baseline-a',baseline_passed:3,total_cases:3,minimum_pass_bps:6667,maximum_drop_bps:3334,source_runtime:source,initiated_by:'alice',created_by:'user:admin',created_at:1000}
  value=policy
  assert.equal((await c.migrationPolicyGet('org-a','policy-a')).baseline_passed,3)
  for(const patch of [{zone:'zone-b'},{id:'other'},{baseline_passed:4}]){
    value={...policy,...patch};await assert.rejects(c.migrationPolicyGet('org-a','policy-a'),{code:'EVALUATION_POLICY_RESPONSE_INVALID'})
  }
  const comparison={kind:'MigrationComparison',id:'comparison-a',zone:'zone-a',asset_id:'asset-a',policy_id:'policy-a',baseline_run_id:'baseline-a',candidate_run_id:'run-a',metadata_digest:digest,spec_digest:digest,dataset_digest:digest,rubric_digest:digest,total_cases:3,baseline_passed:3,candidate_passed:2,minimum_pass_bps:6667,maximum_drop_bps:3334,passed:false,created_by:'user:admin',created_at:2000}
  value=comparison
  assert.equal((await c.migrationCompare('org-a','run-a')).passed,false)
  for(const patch of [{zone:'zone-b'},{candidate_run_id:'other'},{passed:true},{candidate_passed:4}]){
    value={...comparison,...patch};await assert.rejects(c.migrationCompare('org-a','run-a'),{code:'EVALUATION_COMPARISON_RESPONSE_INVALID'})
  }
})
