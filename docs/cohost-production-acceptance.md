# Co-host production acceptance

The shared-runtime candidate follows the shared
[runtime release pins](../src/server/nexus/runtime-versions.json). The dated
production runs below establish acceptance only of the versions they record.
Ordinary scode keeps its direct model connection. Controlled co-host sessions
use the native Nexus model mount for parent, child and compaction requests.

## Deployment scope

Keep the current k8s default while validating co-host accounts. Set
`MOSS_COHOST_ALLOWED_USERS` to comma-separated Moss user UUIDs. An empty value
denies every co-host account; an unset value keeps the private deployment's
existing behavior. The guard applies to creation and subsequent spawn attempts.
Creation rejects an unlisted account before writing a session record.

The owner-Pod candidate supplies each session owner's SudoRouter credential to
that Pod's private model backend. Metered accounts without an owner credential
fail startup. The earlier external co-host deployment used a deployment-level
credential; do not migrate its users until owner billing and runtime recovery
have passed live acceptance. See [shared Agent runtime](shared-agent-runtime.md).

Configure `MOSS_COHOST_NEXUS_MODE=external`, endpoint and TLS CA/cert/key for the
execution daemon. The primary `MOSS_NEXUS_*` connection continues to serve the
deployment's Vault. Bind the co-host daemon to loopback and use mTLS.

Reassert the `/model` backend on every daemon start. This deployment's root uses
the node-local fallback metastore; a dynamically mounted backend is not rebound
after a cold restart. Bundle the bootstrap script for Node and install the
operator-adjusted [systemd drop-in](../deploy/nexus-cohost-model.conf). Its
`ExecStartPost` waits for the mTLS endpoint before configuring the backend. Keep
the provider key in the daemon's private environment file. Do not add it to
mount parameters. The bootstrap must finish before the service is considered
started.

## Real model workflow

Use a real provider credential in the daemon's environment. The bootstrap
script puts the provider URL and storage path in mount metadata and leaves the
credential out of the mount parameters. Its optional fifth argument writes a
fresh Moss session-minter identity to a private directory.

```sh
bun scripts/e2e/cohost-model-bootstrap.ts \
  127.0.0.1:8444 /private/cohost/data/tls \
  https://hk.sudorouter.ai /private/cohost/model-cache /private/cohost/moss-tls

MOSS_COHOST_LIVE=1 COHOST_E2E_MODEL=gpt-6-luna \
  bun scripts/e2e/cohost-real-model-workflow.ts \
  /private/cohost/data/tls 127.0.0.1:8444 /private/evidence/native
```

The workflow creates fresh order, delivery and packing data. A real child reads
the order; the parent saves its subtotal, compacts actual history, applies the
previously reviewed charge and packing requirement, then saves the final quote.
After stopping and restoring the durable session, another real turn must save
the same quote using conversation memory. Assertions check exact file values,
actual compaction size reduction, approval events, native model requests and
the absence of failed tools. Failures stop the test and retain private evidence.

## Deployed session API

Use an isolated acceptance account. Its private credentials file contains
`username`, `password` and
`fixture_owner: "pc3-production-acceptance-20261010"`.

```sh
MOSS_COHOST_LIVE=1 bun scripts/e2e/server-session-live.ts \
  https://agent.sudoprivacy.com /private/acceptance-login.json \
  /private/evidence/deployed cohost k8s
```

This checks real login, model selection, session creation, dependent model
turns, WebSocket reattachment, the persisted HTTP transcript and termination.
Set `MOSS_SESSION_LEGACY_RUNTIME=1` to exercise the legacy `runtime_type` request
field as well. Both request formats must select the requested runtime.
The account's model preference is set to gpt-6-luna. Use a fresh account and
disable it after acceptance. Evidence may contain conversation data and belongs
in private storage.

With an isolated Chrome profile and `ai-dev-browser` on `PYTHONPATH`, inspect
the real recorded sessions through the UI:

```sh
MOSS_COHOST_LIVE=1 MOSS_E2E_BROWSER_PORT=9423 \
  python scripts/e2e/server-session-browser-live.py \
  https://agent.sudoprivacy.com /private/acceptance-login.json \
  /private/evidence/deployed/acceptance.json /private/evidence/browser
```

The browser test signs in through the visible login form and checks each
runtime badge, recorded conversation and session list. Image fields are shown
for their corresponding runtime, so other runtimes do not display a Docker
default image. The card uses a general runtime heading.

CI typechecks the live scripts. The packaged installer E2E checks that an
unlisted co-host account receives 403 without a new session row. It also submits
both k8s request formats to an installation without a cluster and checks that
they fail as k8s instead of starting the default runtime. Existing native
co-host CI exercises two owners, actual daemon process restarts, the model
startup bootstrap and restoration of exact conversation history. Run the real model
scripts locally before committing changes to their workflow.

The real-daemon CI also runs the recovery workflow in fresh Linux containers
with `MOSS_COHOST_PID_NAMESPACE=1`. The released daemon runs as native PID 1.
Two restarts deliberately reuse the exact `1.1` runtime PID while preserving
the same durable session. The workflow respects the existing crashed-writer
lease before allocating a replacement; it never force-unlocks it. The old
connected Moss client must reject its retired channel, and cancelling through
that old reference must leave the replacement able to load exact history and
complete a dependent model/file turn. This test uses the real credential,
storage and transport paths with a scripted model endpoint.

## Recorded live acceptance

### Read-only deployment snapshot, 2026-10-18 10:54 UTC

The running Moss release link points to `server-v0.1.68`. In the configured
`moss-sessions` namespace, twelve running non-fixture owner pods share the
`my-moss-runtime:0.1.67-amd64` image and the same image digest. Direct
`nexusd-cohost --version` queries in three of them report co-host `v0.2.33`,
engine `33ffea1`, Nexus VFS `v0.8.17` and plugin ABI 7. The four older pods
all have `user-pod-e2e-*` owner annotations; they retain two earlier acceptance
images. These observations verify image adoption and the sampled binaries.
They do not establish a fresh complete product recovery journey for every
owner. No service, pod or stored user data was changed during inspection.

### Earlier real model workflows

On 2026-10-10, the actual SudoCloud VM passed the real provider workflow:
16 native Nexus model requests, 9 approvals and 3 persisted results. Compaction
reduced estimated history from 11,355 to 3,136 tokens; the continued and restored
turns retained the exact order and packing values. An isolated Moss candidate on
that VM also passed the deployed session API workflow and the unlisted-account
403 check. Its database was separate from customer data.
The same candidate passed the k8s API workflow with the production's existing
gvisor image. Use a separate namespace and ServiceAccount for a candidate with
its own database: the primary server's orphan sweep otherwise removes its pods.

The primary broker's production snapshot passed reads with 0.8.4 and again after
returning to 0.8.0. The actual broker upgrade preserved its CA, Vault master key,
the Vault 0.5.68 plugin and 591 original Vault content files. Moss's temporary
`moss:config/_health-probe` is a known mutable startup probe, so compare user
content separately from that one probe. Keep full request and conversation
evidence in private storage.

The production co-host service was restarted with the startup hook on 2026-10-10.
The real workflow passed again with 15 native model requests, 8 approvals and
3 persisted results. Compaction reduced history from 11,232 to 3,011 tokens.
