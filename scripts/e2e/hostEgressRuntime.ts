/** Observe an operator-pinned local cohost through the installed shared placement gate. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'

export const hostRuntimeSchema = z.object({
  pinFile: z.string().refine(isAbsolute), pinSha256: z.string().regex(/^[a-f0-9]{64}$/),
  placementLibrary: z.string().refine(isAbsolute), placementLibrarySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type HostRuntimeQualification = z.infer<typeof hostRuntimeSchema>

export function assertLocalEgressDeployment(
  deployment: { runtimeDefaults?: { type?: string }; egressGate?: { localPolicyFile?: string; localOrganizationId?: string } },
  organizationId: string,
) {
  assert.equal(deployment.runtimeDefaults?.type, 'cohost', 'Local qualification requires the deployed cohost default')
  assert.equal(deployment.egressGate?.localOrganizationId, organizationId, 'Qualify only the configured local policy organization')
  assert(deployment.egressGate?.localPolicyFile && isAbsolute(deployment.egressGate.localPolicyFile), 'Use the controller-owned local policy file')
}

export function readHostEgressSnapshot(profile: HostRuntimeQualification, context: { policyFile: string; endpoint: string }) {
  const bytes = readFileSync(profile.pinFile)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), profile.pinSha256, 'Local placement pin changed')
  const document = JSON.parse(bytes.toString('utf8'))
  assert.equal(document.policyLive, context.policyFile, 'Observe the policy path actually selected by Moss')
  const pin = document.container
  assert(pin.mounts.some((mount: { source: string; readOnly: boolean }) => mount.readOnly && mount.source === dirname(context.policyFile)),
    'The selected runtime must mount the controller policy directory read-only')
  // Reuse Stack's real image/user/mount/capability/init-executable checks. The
  // verifier reads its pinned source once before executing the validated bytes.
  const program = `import hashlib,json,pathlib,subprocess,sys,types
path=pathlib.Path(sys.argv[1]);raw=path.read_bytes()
assert hashlib.sha256(raw).hexdigest()==sys.argv[2], 'Placement library changed'
module=types.ModuleType('qualified_placement');module.__file__=str(path)
exec(compile(raw,str(path),'exec'),module.__dict__)
request=json.load(sys.stdin);pin=request['pin'];receipt=module.container_state(pin,True)
row=json.loads(subprocess.check_output(['docker','inspect','--type','container',pin['id']],text=True,timeout=15))[0]
assert row['State']['Running'] and row['State']['Pid']>0
args=row['Args'];assert args[args.index('--bind-addr')+1]==request['bind'], 'Moss execution endpoint differs from the container binding'
mount=next(item for item in pin['mounts'] if item['readOnly'] and item['source']==request['policyDirectory'])
environment=dict(item.split('=',1) for item in row['Config']['Env'])
assert environment.get('NEXUS_EGRESS_GATE_CONFIG')==mount['target']+'/'+request['policyFilename'], 'Native policy path differs'
print(json.dumps(dict(receipt,uid=receipt['id'],restarts=row['RestartCount'],startedAt=row['State']['StartedAt'],pid=row['State']['Pid'])))
`
  const result = spawnSync('python3', ['-I', '-c', program, profile.placementLibrary, profile.placementLibrarySha256], {
    input: JSON.stringify({ pin, bind: new URL(context.endpoint).host,
      policyDirectory: dirname(context.policyFile), policyFilename: context.policyFile.split('/').at(-1) }),
    encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024,
  })
  assert.equal(result.status, 0, 'The installed shared local placement verifier refused the runtime')
  return z.object({ uid: z.string().regex(/^[a-f0-9]{64}$/), restarts: z.number().int().nonnegative(),
    startedAt: z.string().min(1), pid: z.number().int().positive(), imageSha256: z.string(),
    binarySha256: z.string(), runtime: z.string() }).parse(JSON.parse(result.stdout))
}
