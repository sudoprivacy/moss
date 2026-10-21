import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LangGraphSourceBaseline } from './langgraphSourceBaseline.js'
const digest='sha256:'+'a'.repeat(64)
async function fixture(t:TestContext, script='') {
 const dir=await mkdtemp(join(tmpdir(),'source-runner-test-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const python=join(dir,'interpreter')
 await writeFile(python,`#!${process.execPath}\nconst source={source_digest:${JSON.stringify(digest)},entry_digest:${JSON.stringify(digest)},python:'test',distributions:[['langgraph','1.0.5']]};if(process.argv.includes('--inspect')){console.log(JSON.stringify(source));process.exit(0)};const send=x=>process.stdout.write(JSON.stringify({protocol:'agent-source-stdio/v1',...x})+'\\n');let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const n=buffer.indexOf('\\n'),frame=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(frame.kind==='execute'){if(JSON.stringify(frame.expected_snapshot)!==JSON.stringify(source))process.exit(3);if(Object.keys(process.env).some(k=>/TOKEN|SECRET|KEY/.test(k)))process.exit(4);${script || "send({kind:'trace',node:'original',phase:'completed',origin:'worker_reported'});send({kind:'model_request',sequence:1,messages:[{role:'user',content:frame.query}],max_tokens:32})"}}else{send({kind:'completed',answer:frame.answer,model_calls:1});process.exit(0)}}});`,{mode:0o700})
 const artifact:any={image:{profile:'langgraph-stdio-v1',source_digest:digest,model_name:'model',max_output_tokens:32}}
 const runner=new LangGraphSourceBaseline({python,entry:join(dir,'entry.py'),project:join(dir,'project.py')})
 return {runner,artifact,options:{artifact,query:'6*7',timeoutSeconds:5,maxModelCalls:1,signal:AbortSignal.timeout(5000),trace:async()=>{},model:async()=> '42'}}
}
void test('source process uses independent protocol, checkpoints before dispatch and has no inherited credentials',async t=>{
 const f=await fixture(t),snapshot=await f.runner.snapshot(f.artifact,f.options.signal),events:string[]=[]
 assert.equal(snapshot.revision_strength,'local_source_digest')
 const output=await f.runner.run({...f.options,model:async()=>{events.push('model');return '42'}},snapshot,'case-a',async()=>{events.push('admit')},async evidence=>{assert.equal(evidence.request_id,'case-a');events.push('observe')})
 assert.deepEqual(output,{answer:'42',modelCalls:1});assert.deepEqual(events,['observe','admit','model'])
})
void test('wrong artifact, changed runtime and refused authorization do not invoke source model',async t=>{
 const f=await fixture(t),snapshot=await f.runner.snapshot(f.artifact,f.options.signal);let models=0
 f.options.model=async()=>{models++;return '42'}
 await assert.rejects(f.runner.run(f.options,{...snapshot,runtime_digest:'sha256:'+'b'.repeat(64)},'case-a',async()=>{},async()=>{}),{code:'EVALUATION_SOURCE_CHANGED'})
 await assert.rejects(f.runner.run(f.options,snapshot,'case-a',async()=>{throw new Error('revoked')},async()=>{}))
 f.artifact.image.source_digest='sha256:'+'b'.repeat(64)
 await assert.rejects(f.runner.snapshot(f.artifact,f.options.signal),{code:'EVALUATION_SOURCE_MISMATCH'})
 assert.equal(models,0)
})
void test('source runtime reports change without replaying model calls',async t=>{
 const f=await fixture(t,"send({kind:'failed',code:'EVALUATION_SOURCE_CHANGED'});process.exit(1)"),snapshot=await f.runner.snapshot(f.artifact,f.options.signal)
 await assert.rejects(f.runner.run(f.options,snapshot,'case-a',async()=>{},async()=>{}),{code:'EVALUATION_SOURCE_CHANGED'})
})
