import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DifySourceBaseline } from './difySourceBaseline.js'
const digest='sha256:'+'a'.repeat(64)
function fixture(){
 let posts=0,workflow='workflow-1',key='app-test',listedKey='app-test',workspace='workspace-1',changed=false
 const traces:any[]=[], observations:any[]=[]
 const plan:any={source_digest:digest,source_model:'model',source_provider:'provider',source_plugin:'plugin',llm_node:'llm',prompts:[{role:'user',content:'{{query}}'}],temperature:0,max_tokens:128,conversation_mode:'independent_turns'}
 const artifact:any={asset_id:'asset-a',dify_plan:plan}
 const compiled={...plan,source_digest:'sha256:'+'b'.repeat(64)}
 const request=(async(input: Parameters<typeof fetch>[0],init: Parameters<typeof fetch>[1])=>{
  const url=new URL(String(input));assert.equal(init?.redirect,'error');assert.equal(url.origin,'http://127.0.0.1:10000')
  if(url.pathname.endsWith('/workspaces'))return Response.json({workspaces:[{id:workspace,current:true}]})
  if(url.pathname.endsWith('/api-keys'))return Response.json({data:[{token:listedKey}]})
  if(url.pathname.endsWith('/workflows/publish'))return Response.json({id:workflow})
  if(url.pathname.endsWith('/export')){assert.equal(url.searchParams.get('workflow_id'),workflow);assert.equal(url.searchParams.get('include_secret'),'false');return Response.json({data:'reviewed DSL'})}
  if(url.pathname==='/v1/parameters')return Response.json({user_input_form:[]})
  if(url.pathname==='/v1/chat-messages'){
   posts++;const body=JSON.parse(String(init?.body));assert.equal(body.conversation_id,'');assert.equal(body.query,'6 * 7')
   if(changed)workflow='workflow-2'
   const frames=[{event:'workflow_started',workflow_run_id:'workflow-run',message_id:'message-1',task_id:'task-1'}, {event:'node_started',data:{node_id:'llm'}},{event:'node_finished',data:{node_id:'llm',status:'succeeded'}},{event:'message',answer:'42'},{event:'message_end'},{event:'workflow_finished',data:{status:'succeeded'}}]
   return new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
  }
  throw new Error('unexpected request')
 }) as typeof fetch
 const source=new DifySourceBaseline({orgId:'org-a',assetId:'asset-a',origin:'http://127.0.0.1:10000',appId:'app-a',workspaceId:'workspace-1',credentials:async()=>({apiKey:key,consoleToken:'console',csrfToken:'csrf'}),request},{hostedInspectDify:async()=>compiled})
 const options:any={artifact,query:'6 * 7',signal:AbortSignal.timeout(5000),trace:async(frame:any)=>{traces.push(frame)}}
 return {source,artifact,options,traces,observations,observe:async(value:any)=>{observations.push(value)},posts:()=>posts,change:()=>{changed=true},wrongKey:()=>{key='app-other'},wrongWorkspace:()=>{workspace='other'},changedPlan:()=>{compiled.source_model='other'}}
}
void test('baseline reads published workflow and executes actual Dify protocol once with original node trace',async()=>{
 const f=fixture(),snapshot=await f.source.snapshot(f.artifact,f.options.signal)
 assert.equal(snapshot.revision_strength,'observed_source_snapshot')
 assert.deepEqual(await f.source.run(f.options,snapshot,'case-a',async()=>{},f.observe),{answer:'42',modelCalls:0})
 assert.equal(f.observations.at(-1).workflow_run_id,'workflow-run');assert.equal(f.posts(),1);assert.deepEqual(f.traces,[{node:'llm',phase:'started',origin:'worker_reported'},{node:'llm',phase:'completed',origin:'worker_reported'}])
})
void test('changed key, workspace or executable plan denies before source dispatch',async()=>{
 for(const mutate of ['wrongKey','wrongWorkspace','changedPlan'] as const){
  const f=fixture(),snapshot=await f.source.snapshot(f.artifact,f.options.signal);f[mutate]()
  await assert.rejects(f.source.run(f.options,snapshot,'case-a',async()=>{},f.observe));assert.equal(f.posts(),0)
 }
})
void test('publication change during execution preserves uncertainty and never repeats the source call',async()=>{
 const f=fixture(),snapshot=await f.source.snapshot(f.artifact,f.options.signal);f.change()
 await assert.rejects(f.source.run(f.options,snapshot,'case-a',async()=>{},f.observe),{code:'EVALUATION_SOURCE_CHANGED'})
 assert.equal(f.posts(),1)
})

void test('revocation or source checkpoint failure prevents dispatch; failure retains remote references', async()=>{
 const f=fixture(),snapshot=await f.source.snapshot(f.artifact,f.options.signal)
 await assert.rejects(f.source.run(f.options,snapshot,'case-a',async()=>{throw new Error('revoked')},f.observe))
 assert.equal(f.posts(),0)
 await assert.rejects(f.source.run(f.options,snapshot,'case-a',async()=>{},async()=>{throw new Error('store unavailable')}))
 assert.equal(f.posts(),0)
 f.change()
 await assert.rejects(f.source.run(f.options,snapshot,'case-a',async()=>{},f.observe),{code:'EVALUATION_SOURCE_CHANGED'})
 assert.equal(f.posts(),1);assert.equal(f.observations.at(-1).workflow_run_id,'workflow-run')
})
