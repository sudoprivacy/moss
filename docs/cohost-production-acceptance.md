# Co-host production acceptance

The release pins Nexus VFS 0.8.4, Vault 0.5.68 and nexusd-cohost 0.2.26.
Ordinary scode keeps its direct model connection. Controlled co-host sessions
use the native Nexus model mount for parent, child and compaction requests.

## Deployment scope

Keep the current k8s default while validating co-host accounts. Set
`MOSS_COHOST_ALLOWED_USERS` to comma-separated Moss user UUIDs. An empty value
denies every co-host account; an unset value keeps the private deployment's
existing behavior. The guard applies to creation and subsequent spawn attempts.
Creation rejects an unlisted account before writing a session record.

The co-host native backend currently reads a deployment credential from the
daemon environment. It does not consume the user's runner credential. Keep this
rollout limited until per-user model billing is implemented and verified.

Configure `MOSS_COHOST_NEXUS_MODE=external`, endpoint and TLS CA/cert/key for the
execution daemon. The primary `MOSS_NEXUS_*` connection continues to serve the
deployment's Vault. Bind the co-host daemon to loopback and use mTLS.

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

CI typechecks the live scripts. The packaged installer E2E checks that an
unlisted co-host account receives 403 without a new session row. It also submits
both k8s request formats to an installation without a cluster and checks that
they fail as k8s instead of starting the default runtime. Existing native
co-host CI exercises two owners and daemon restart recovery. Run the real model
scripts locally before committing changes to their workflow.

## Recorded live acceptance

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
