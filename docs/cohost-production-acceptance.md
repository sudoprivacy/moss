# Co-host production acceptance

Ordinary scode keeps its direct model connection. Controlled co-host sessions
use the native Nexus model mount for parent, child and compaction requests.

## Production verification on 2026-10-18

The observed SudoCloud server runs
[Moss 0.1.68](https://github.com/sudoprivacy/moss/releases/tag/server-v0.1.68)
with the verified 0.1.67 owner-runtime manifest: paired scode/nexusd-cohost
0.2.33, Nexus 0.8.17 and plugin ABI 7. A server update does not establish that
the owner-runtime image changed; inspect the effective manifest and image.

The running process sets `MOSS_DEFAULT_RUNTIME=cohost`. Its `server.json`
still contains `runtimeDefaults.type=k8s`, which the environment overrides.
Verify the process environment before reporting or changing the default.
An ordinary production WebUI login, New task and visible Send click created a
co-host session without a runtime override. The real model returned a fresh
marker, and the server's session record independently confirmed co-host placement.

An isolated shared-billing organization passed these production checks:

- On Moss 0.1.67, with its model account disabled, member creation returned 409 before writing
  an identity. Restoring the account allowed creation only after a real
  SudoRouter key was ready. Repeating the same idempotent request returned the
  same user and key. The extra regression member and key were disabled afterward.
- The deployed session API passed three real GPT-6 Luna turns, a WebSocket
  reattachment and persisted HTTP history. The native `/model` backend used the
  member's key; the scode proxy pointed to `nexus:///model` with no provider key.
- A separate Sonnet 4.6 request through that same native mount returned 23 input
  and 16 output tokens. The member key and organization were charged USD
  0.000272; the service key was unchanged. This is the positive billing proof.

The organization began with USD 0.10, a USD 0.05 member limit and a USD 0.02
service limit. No limits were increased. After acceptance, the sessions, member
identity, member key, service key and parent model account were stopped or
disabled. The temporary organization login override was restored to inheritance;
the platform login policy was unchanged. Private receipts retain the evidence.

### Upstream GPT usage limitation

The three GPT requests reached the correct member key, but their unmodified
gateway replies reported zero `prompt_tokens` and `completion_tokens` alongside
nonzero `total_tokens` (6,695, 6,751 and 6,804). The stored outbound requests
included `stream_options.include_usage=true`. The gateway recorded zero cost for
those requests. Do not count them as positive billing acceptance, infer an input
and output split from the total, or substitute estimated charges. The Sonnet
request above establishes that native routing and member billing work when the
provider supplies valid usage; the GPT gateway conversion remains unresolved.

### Browser and capacity boundaries

The production WebUI browser handoff passed with a separate Chromium touch
context on 2026-10-17: Take control, Unicode input, Return to AI, exact model
readback, one trusted form submission, the same browser/profile/cookie, and
history after reload. This is not an iPhone Safari result. Physical iPhone
Safari acceptance remains pending; see the
[SudoWork browser design](https://github.com/sudoprivacy/sudowork/blob/dev/docs/sudowork-browser-sessions.md).

A fresh owner initially failed with 503 `RUNTIME_START_FAILED`. Its actual Pod
condition was `Unschedulable: Insufficient cpu`; no model request had run.
Parking two completed acceptance runtimes, with exact owner/UID checks and no
unfinished sessions, released 200m of CPU requests. Their PVCs, Secrets and
Services were retained. The subsequent live workflow passed. Monitor owner Pod
capacity; successful runtime reuse does not prove a new owner can be scheduled.

## Deployment scope

Use the effective co-host default for this deployment. Set
`MOSS_COHOST_ALLOWED_USERS` for a restricted rollout with comma-separated Moss
user UUIDs. An empty value
denies every co-host account; an unset value keeps the private deployment's
existing behavior. The guard applies to creation and subsequent spawn attempts.
Creation rejects an unlisted account before writing a session record.

The owner-Pod deployment supplies each session owner's SudoRouter credential to
that Pod's private model backend. Metered accounts without an owner credential
fail startup. Keep the owner model configuration in its private runtime Secret.
The earlier external co-host deployment used a deployment-level credential and
does not provide per-member billing. See
[shared Agent runtime](shared-agent-runtime.md).

### Legacy external acceptance fixture

The external-daemon instructions below describe the historical isolated fixture,
not the current metered owner-Pod deployment. Use a dedicated provider credential
and keep this fixture separate from customer billing.

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
  /private/evidence/deployed cohost
```

This checks real login, model selection, session creation, dependent model
turns, WebSocket reattachment, the persisted HTTP transcript and termination.
Set `MOSS_SESSION_LEGACY_RUNTIME=1` to exercise the legacy `runtime_type` request
field as well. Both request formats must select the requested runtime.
Pass `k8s` only for a separate deployment that deliberately supports the legacy
runtime. The production owner-Pod deployment with a co-host default rejects new
non-native runtime requests before persisting a session.
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

The production co-host service was restarted with the startup hook on 2026-10-10.
The real workflow passed again with 15 native model requests, 8 approvals and
3 persisted results. Compaction reduced history from 11,232 to 3,011 tokens.
