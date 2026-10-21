# Hosted model dispatch through Nexus

The model gateway can compose a `NexusModelRelay` with a configured Nexus target.
Production `run` calls remain refused unless this content path is present. A
separately authorized synthetic evaluation may use the direct Router path to
record a baseline. Configuration alone does not attest a content gate or L2 grade.

The relay listens only on 127.0.0.1. Configure its base URL as the Nexus llm_mount
upstream and configure a private mount credential in Nexus. A deployment must use
an appropriate Nexus build (`driver-ai,egress-gate-presidio`) and explicitly arm
the gate on the selected model mount. Each Moss instance requires its own relay
and mount routing; an arbitrary load-balanced relay cannot resolve another
instance's in-memory request. This feature does not claim cross-instance failover.

A dispatch proceeds as follows:

1. Authenticate the real IAM execution grant and durably reserve the model call
   and its per-grant call count. Replay never creates another side effect.
2. Issue one short-lived, model- and quota-constrained Router token. Persist only
   token metadata. The raw key stays in the forward closure in memory.
3. Write the model request through the existing Nexus HTTP-exchange path. The
   prompt carries only an opaque one-use `x-request-id`, never a per-call key.
4. Nexus's existing pre-write hook refuses or rewrites content before the mount
   dispatch. The authenticated relay claims its pending ID once, validates fixed
   model/options/message roles, and permits only message-text rewrites.
5. Recheck live IAM authorization and expiry immediately before actual Router
   dispatch. A revoked grant cannot dispatch after spending time in the hook.
6. Require the matching relay response and a completed VFS exchange. A stale
   reply, lost acknowledgement or interrupted call never becomes a retry.
7. Disable the Router token and reconcile actual Router ledger identities. Token
   cleanup and ledger uncertainty remain explicit, independently of the answer.

An exact authenticated Nexus pre-write rejection is stored as `contentRejection`.
It binds the hook, request digest and path; a free-text transport error cannot
prove a pre-dispatch rejection. After dispatch, errors remain `unknown`.
The relay's lifetime signal cancels late callbacks; restart cannot reconstruct a
lost pending capability. Ordinary GET/startup does not publish or migrate data.

## Validation and limits

Unit tests cover changed routing/budgets/roles, duplicate delivery, wrong mount
credentials, stale replies, cancellation, and revocation while content inspection
runs. The isolated real integration used the current feature-enabled Nexus
kernel, actual Nexus IAM, and an actual Router ledger: deny, redact, classifier
outage, revocation, and reconstructed gateway replay passed. Per-call keys were
absent from persisted VFS blobs. Supported Dify and LangGraph images each passed
six shared synthetic arithmetic cases through the trusted supervisor and relay.

These observations qualify the exercised path and samples only. The full
hosted-task/evaluation coordinator, administrative execution UI, publication
admission, HA/offline qualification, and complete AM/R acceptance remain separate
work. Container worker trace is explicitly `worker_reported`; Router metering
comes from the trusted Router ledger. This does not certify all Dify nodes,
arbitrary LangGraph projects, model/tool paths on other platforms, or all 1.1.
