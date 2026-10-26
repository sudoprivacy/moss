import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DeviceDeployClient, type DeviceDeployEffect } from './deviceDeploy.js'

void test('installed device port passes fixed arguments without control credentials and recovers a lost child reply', {
  skip: process.platform !== 'linux' ? 'Linux user-service placement' : false,
}, async t => {
  const root = mkdtempSync(join(homedir(), '.moss-device-port-'))
  chmodSync(root, 0o700)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Production's system Python has trusted ancestors. A test runner may live
  // in a mutable build checkout, so stage its exact bytes privately instead.
  const interpreter = join(root, 'node')
  copyFileSync(process.execPath, interpreter); chmodSync(interpreter, 0o700)
  const entry = join(root, 'entry.cjs'), registry = join(root, 'registry.json')
  const effect: DeviceDeployEffect = { deploymentId: 'device1', ownerId: 'owner1', planId: 'approved1', planSha256: 'a'.repeat(64), operationId: 'original1' }
  writeFileSync(registry, '{}', { mode: 0o600 })
  writeFileSync(entry, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),root=path.dirname(__filename);
if(args[0]!=='operation'||args[2]!=='--registry'||args[3]!==path.join(root,'registry.json'))throw Error('wrong entry');
if(process.env.MOSS_CONTROL_TEST_SECRET||process.env.MOSS_AGENT_CONTROL_DEPLOYMENT_ID)throw Error('credential environment inherited');
fs.appendFileSync(path.join(root,'calls'),args[1]+'\\n');
const effect=${JSON.stringify(effect)};
if(args[1]==='inspect'){if(args[4]!=='--plan-id'||args[5]!==effect.planId)throw Error('wrong plan');console.log(JSON.stringify({...effect,description:'Original product update'}));}
else if(args[1]==='submit'){
 if(args[4]!=='--plan-id'||args[5]!==effect.planId||args[6]!=='--operation-id'||args[7]!==effect.operationId)throw Error('wrong effect');
 fs.writeFileSync(path.join(root,'effect'),JSON.stringify(effect));process.exit(4);
}else if(args[1]==='query'){
 if(args[4]!=='--operation-id'||args[5]!==effect.operationId)throw Error('wrong recovery');
 const original=JSON.parse(fs.readFileSync(path.join(root,'effect')));
 console.log(JSON.stringify({...original,schemaVersion:1,action:'runtime.deploy',status:'completed',outcome:'completed',domainJoinAccepted:false,
 runnerSha256:'c'.repeat(64),implementationSha256:'d'.repeat(64),osUid:process.getuid(),unit:'sudo-deploy-'+'e'.repeat(40)+'.service'}));
}else throw Error('unapproved command');`, { mode: 0o600 })
  const config = { schemaVersion: 1 as const, python: interpreter, entry,
    entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'), registry, sudostackRoot: root }
  const client = new DeviceDeployClient(config)
  const previous = process.env.MOSS_CONTROL_TEST_SECRET
  process.env.MOSS_CONTROL_TEST_SECRET = 'must-not-reach-child'
  t.after(() => { if (previous === undefined) delete process.env.MOSS_CONTROL_TEST_SECRET; else process.env.MOSS_CONTROL_TEST_SECRET = previous })
  await assert.rejects(client.submit(effect), /unconfirmed/)
  assert.equal((await client.query(effect) as any).outcome, 'completed')
  assert.deepEqual(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n'), ['inspect', 'submit', 'query'])
  await assert.rejects(client.query({ ...effect, planSha256: 'b'.repeat(64) }), /another effect/)
  writeFileSync(entry, readFileSync(entry, 'utf8') + '\n// changed after installation\n')
  await assert.rejects(client.query(effect), /entry changed/)
})
