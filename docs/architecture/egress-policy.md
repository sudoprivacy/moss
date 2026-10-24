# Egress policy administration

Moss manages policy; the existing Nexus `egress_gate` service enforces it.
Shared policy validation, scoped persistence and runtime delivery live in
`sudostack/packages/egress-policy` and `packages/user-runtime`. Deployment
profiles belong in sudocloud, sudoprivate and sudoedge. Cloud starts disabled.

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
for one analyzer per compute node, or an optional dedicated `analyzerImage`
per Pod. These options are mutually exclusive. The node relay uses its actual
Kubernetes node IP and an infrastructure-owned TLS/authentication Secret that
is mounted only in the relay container. Tenant policy retains a loopback URL.

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
Local and external model routes must keep their separate provider credentials
so local inference cannot fall back into an external account outside the gate.

## Evidence

`egressPolicyService.node-test.ts` covers desired-versus-applied state and
propagation that preserves organization overrides. The real Node server
journey in `lbLifecycleE2e.test.ts` exercises authentication, role boundaries,
scope injection, revision conflicts, overrides and inheritance over HTTP.
`runtimeModelEnvironment.node-test.ts` verifies model-route preservation during
policy delivery. Shared SDK tests cover Pod and credential preservation,
relay credential isolation, file replacement and separate model accounts.

Native hook acceptance, real model upstream observations, analyzer failure and
restart recovery remain deployment acceptance. Record the actual executable
digest, analyzer image and runtime-reported policy revision in each deployment
repository; unit tests and a built admin page do not constitute production
acceptance.
