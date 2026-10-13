import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {crashFixture} from '../../../../src/server/testing/externalProviderCrashFixture.ts';
const directory=await mkdtemp(join(tmpdir(),'dify-review2-reopen-'));
let fixture;
try{
 fixture=await crashFixture(directory);
 const agent=await fixture.service.administration.onboard(fixture.actor,fixture.body);
 const binding=await fixture.store.binding(fixture.actor,agent.id);
 const task=await fixture.store.create(fixture.actor,{agent_id:agent.id,query:'synthetic reopen',idempotency_key:randomUUID()},binding,120000);
 const raw='{"reply":"persisted raw';
 await fixture.store.mutate(task.id,current=>{current.status='running';current.attempt_id=randomUUID();current.answer='persisted';current.raw_answer='{"reply":"persisted';return 'answer'});
 await fixture.store.mutate(task.id,current=>{current.answer='persisted raw';current.raw_answer=raw;return 'answer'});
 await fixture.service.close();await fixture.driver.close();fixture=undefined;
 fixture=await crashFixture(directory);
 const recovered=await fixture.store.task(fixture.actor,task.id);
 assert.equal(recovered.raw_answer,raw);assert.equal(recovered.answer,'persisted raw');
 await fixture.store.mutate(task.id,current=>{current.status='unknown';return 'status'});
 await fixture.service.close();await fixture.driver.close();fixture=undefined;
 fixture=await crashFixture(directory);
 const terminal=await fixture.store.task(fixture.actor,task.id);
 assert.equal(terminal.status,'unknown');assert.equal(terminal.raw_answer,raw);
 const result={date:new Date().toISOString(),mode:'file-backed SQLite service and driver closed/reopened twice; synthetic fixture; no process kill',checks:{beforeCheckpointRawReopen:true,displayRawConsistent:true,unknownTerminalRawReopen:true}};
 console.log(JSON.stringify(result));
}finally{if(fixture){await fixture.service.close();await fixture.driver.close()}await rm(directory,{recursive:true,force:true})}
