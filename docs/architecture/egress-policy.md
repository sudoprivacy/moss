# Egress policy administration

Moss manages policy; the existing Nexus `egress_gate` service enforces it.
Shared policy validation, scoped persistence and runtime delivery live in
`sudostack/packages/egress-policy` and `packages/user-runtime`. Deployment
profiles belong in sudocloud, sudoprivate and sudoedge. Cloud starts disabled.
Delivery may leave the platform default disabled. Acceptance must demonstrate
that an administrator can enable protection in Moss, observe matching native
application status, verify real model redaction and refusal, and disable it
again without restarting the controller or runtime. Saving the switch alone
does not establish enforcement.

## Management surface

The admin page is `/admin/egress-policy`. It supports platform defaults,
organization overrides, restore inheritance, retry delivery and actual
per-runtime status. Only a super administrator may manage platform defaults.
An organization administrator acts within the authenticated organization;
request bodies cannot select a different organization. All routes require
`admin:settings` and use the established configuration actor resolver.

| Method | Route | Effect |
|---|---|---|
| GET | `/api/v1/settings/egress?scope=platform|organization` | Read desired policy and actual runtime receipts |
| PUT | same | Save `{ policy, expectedRevision }` and attempt delivery |
| POST | `/api/v1/settings/egress/apply?scope=...` | Retry delivery without changing policy |
| POST | `/api/v1/settings/egress/inherit?scope=organization` | Restore defaults using `{ expectedRevision }` |

Responses are not cached. A stale revision returns 409; invalid policy returns
400. A save can succeed while an older or unavailable runtime remains pending
or reports a delivery error. The UI never labels a desired version applied
until the native runtime reports the same revision, mode, enabled state and
mounts. Retry delivery or upgrade an older runtime through existing maintenance.

## Infrastructure configuration

`egressGate.defaultPolicyFile` is an absolute path to the deployment's complete
bootstrap policy. It seeds new policy storage; changing the file does not
overwrite saved policy. No file means disabled defaults with no claimed mounts.

Managed owner Pods use either `egressGate.analyzerRelay = { image, secretName }`
for a shared analyzer host or one analyzer per compute node, or an optional
dedicated `analyzerImage` per Pod. These options are mutually exclusive.
SDK 0.2.2 supports both relay placements through the shared infrastructure
preparer in `sudostack/security/egress-gate/node-analyzer/configure.mjs`.
Its `relayMode: shared` fixes the verified analyzer host address in the Secret;
node mode uses the Pod's actual Kubernetes node IP. Tenant policy cannot change
that address. Both modes verify the analyzer's TLS name, CA and classifier
authentication. The infrastructure-owned Secret is mounted only in the small
relay container, and tenant policy retains a loopback URL.

For an external host cohost, configure `localPolicyFile` and
`localOrganizationId` together. Only that organization may deliver policy to
the file. Other organizations have no local placement. The trusted Moss
controller needs write access; the agent needs read-only access. The cohost
uses the same `NEXUS_EGRESS_GATE_CONFIG` interface as managed Pods and a
Nexus-connected CLI. CLI sessions without Nexus do not gain mandatory DLP.

On controller startup, Moss restores the saved organization policy to the
local file before admitting new model work. Admission requires a matching
native applied receipt; an unavailable runtime or stale revision returns 503.
The shared writer syncs the temporary file before replacement and the parent
directory on POSIX. Mount the parent directory read-only inside an isolated
agent runtime so atomic replacements remain visible. File permissions alone
do not isolate a host agent running under the controller's user account.

Runtime model configuration, credential renewal, upgrades and recovery retain
the policy file. New owner Pods receive the effective organization policy.
When protection is enabled, model session startup checks that selected owner's
native runtime receipt before handing off execution. An old, unavailable or
pending native policy returns 503; a saved policy alone does not admit model
work. If session creation already committed its durable identity, the response
contains the failed session and startup code `EGRESS_POLICY_NOT_APPLIED` instead
of discarding that identity. Its message directs the caller to retry policy
delivery or update the runtime. Disabled Cloud deployments can complete their controlled runtime upgrade
before enabling protection. Existing in-flight work and policy propagation are
still represented by the native applied status, rather than the saved revision.
Local and external model routes must keep their separate provider credentials
so local inference cannot fall back into an external account outside the gate.

For a shared external cohost with several preconfigured model mounts, set
`runtimeDefaults.cohostModelRouting` to `provider-qualified`. The deployment
must build its native aliases as `providerId:modelId` with the shared
`buildCohostModelConfiguration` function. Moss sends that alias when starting
the native execution and when changing models within the same provider, while
retaining the upstream model ID in the UI. Identical local and cloud model
names therefore select different mounts. Unknown aliases fail at the runtime;
they must never fall back to a different account. Switching providers still
requires a new session. Existing single-provider deployments omit this setting.

## Evidence

`egressPolicyService.node-test.ts` covers desired-versus-applied state and
propagation that preserves organization overrides. The real Node server
journey in `lbLifecycleE2e.test.ts` exercises authentication, role boundaries,
scope injection, revision conflicts, overrides and inheritance over HTTP.
`runtimeModelEnvironment.node-test.ts` verifies model-route preservation during
policy delivery. Shared SDK tests cover Pod and credential preservation,
relay credential isolation, file replacement and separate model accounts.

`scripts/e2e/egress-control-live.ts` joins the real HTTP and native paths. Bundle
it with the installed dependencies and run it against a compatible cohost:

```sh
bun build scripts/e2e/egress-control-live.ts --target=node --format=esm \
  --outfile ./egress-control-live.mjs --external=better-sqlite3 \
  --external=@sudo/contracts/common/v1/resource-ref --external=@xenova/transformers \
  --external=onnxruntime-node --external=sharp
MOSS_HOME=/private/new-home node ./egress-control-live.mjs \
  /absolute/candidate/nexusd-cohost /private/new-evidence-directory
```

Run from the Moss checkout with its installed `node_modules`. The home and
evidence directories must be dedicated to this acceptance; the evidence
directory must not exist. It starts its own loopback HTTP model, mTLS cohost,
SQLite store and real Moss server, then cleans up its own processes. It never
changes installed services. Keep its private database, identities and logs off
Git; only the bounded receipt is suitable for sharing.

The seven cases change policy through authenticated HTTP, require the native
applied receipt and exercise managed ACP turns on one daemon. They check
disabled/redact/local/deny/analyzer-outage/malformed/disabled states, separate
provider credentials, zero downstream calls on refusal and original local
history. A fresh Node controller process opens the saved database, restores a
replaced policy file and verifies policy status through HTTP again. This is a
controlled controller replacement, not crash recovery or policy-file OS
isolation. The model upstream is synthetic. The recorded ARM64 candidate run
is [here](../evidence/egress-control-20261025-linux-arm64.json).

Native hook acceptance, real model upstream observations, analyzer failure and
restart recovery remain deployment acceptance. Record the actual executable
digest, analyzer image and runtime-reported policy revision in each deployment
repository; unit tests and a built admin page do not constitute production
acceptance.
