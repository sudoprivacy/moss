import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostedFromEnvironment, configuredSourceBaselines } from './hostedConfiguration.js'

void test('hosted configuration is optional but invalid deployment input fails closed without diagnostics', async () => {
  const previous=process.env.MOSS_AGENT_HOSTED_CONFIG_FILE
  const dir=await mkdtemp(join(tmpdir(),'hosted-configuration-'))
  let databaseWrites=0
  const db={exec:async()=>{databaseWrites++}} as any, registry={scope:()=>({})} as any
  try{
    delete process.env.MOSS_AGENT_HOSTED_CONFIG_FILE
    assert.equal(await hostedFromEnvironment(db),undefined)
    for(const value of ['private malformed data', JSON.stringify({runner:{python:'/usr/bin/python',docker:'/usr/bin/docker'},relays:[],resources:[]}), JSON.stringify({unexpected:'private-secret'})]){
      const path=join(dir,'config.json');await writeFile(path,value)
      process.env.MOSS_AGENT_HOSTED_CONFIG_FILE=path
      await assert.rejects(hostedFromEnvironment(db,registry),{code:'HOSTED_CONFIGURATION_INVALID',message:'HOSTED_CONFIGURATION_INVALID'})
    }
    process.env.MOSS_AGENT_HOSTED_CONFIG_FILE=dir
    await assert.rejects(hostedFromEnvironment(db,registry),{code:'HOSTED_CONFIGURATION_INVALID'})
    process.env.MOSS_AGENT_HOSTED_CONFIG_FILE=join(dir,'config.json')
    await assert.rejects(hostedFromEnvironment(db),{code:'HOSTED_CONFIGURATION_INVALID'})
    assert.equal(databaseWrites,0)
  }finally{
    if(previous===undefined)delete process.env.MOSS_AGENT_HOSTED_CONFIG_FILE;else process.env.MOSS_AGENT_HOSTED_CONFIG_FILE=previous
    await rm(dir,{recursive:true,force:true})
  }
})

void test('source configuration is scoped, rejects duplicate or public credentials and loads secrets per dispatch', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'source-configuration-')), file=join(dir,'secret')
 await writeFile(file,'private-token',{mode:0o600})
 const registry:any={scope:(org:string)=>{assert.equal(org,'org-a')}}
 const entry={profile:'dify-service-api-v1',orgId:'org-a',assetId:'asset-a',origin:'http://127.0.0.1:10000',appId:'app-a',workspaceId:'workspace-a',apiKeyFile:file,consoleTokenFile:file,csrfTokenFile:file}
 try{
  assert.equal(configuredSourceBaselines([entry],registry).size,1)
  assert.throws(()=>configuredSourceBaselines([entry,entry],registry))
  assert.throws(()=>configuredSourceBaselines([{...entry,apiKey:'secret'}],registry))
  assert.throws(()=>configuredSourceBaselines([{...entry,orgId:'other'}],registry))
  const publicFile=join(dir,'public');await writeFile(publicFile,'private-token',{mode:0o644})
  assert.throws(()=>configuredSourceBaselines([{...entry,apiKeyFile:publicFile}],registry))
 }finally{await rm(dir,{recursive:true,force:true})}
})
