import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostedFromEnvironment } from './hostedConfiguration.js'

test('hosted configuration is optional but invalid deployment input fails closed without diagnostics', async () => {
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
