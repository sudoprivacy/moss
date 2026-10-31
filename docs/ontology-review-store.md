# Shared review delivery storage

`OntologyReviewStore` implements the published Sudograph host SDK's asynchronous
review store with Moss's existing `DbDriver`. SQLite initialization and PostgreSQL
migration 26 install the same schema. Every lookup, write, join and input claim
is scoped to the organization selected by the trusted host.

The store retains host settings, immutable comment-to-conversation subscriptions,
provider event references, delivery outcomes and input-digest claims. ShareOne
continues to own comment threads; the compiler continues to own model definitions
and revisions. Credential operations belong to the existing secret provider,
outside this adapter.

Event batches commit atomically before the provider may acknowledge its cursor.
Repeated batches retain event, subscription and message identity without resetting
completed work. Changed identities or mixed-scope batches fail. Input claims use
a database uniqueness constraint so independent controllers cannot assign the
same human input to different inbox items. Retrying the same item retains its
claim; this is not an execution lease. The ordinary chat delivery adapter must
still enforce idempotency using the stable message ID and reconcile interrupted
turns before retrying execution.

Migration 28 adds an independent, atomic dispatch reservation for each inbox
item. Exactly one controller can reserve it, including across database handles
and process restarts. It never expires or resets when delivery fails or the
provider repeats an event. A replacement controller reads the existing native
conversation to recover a pending or completed turn; an unknown outcome requires
reconciliation and cannot trigger another submission. Missing or foreign inbox
items cannot be reserved. Deleting an inbox item removes its bookkeeping.

Database acceptance exercises production initialization, organization isolation,
rollback, duplicate events, immutable routing, independent PostgreSQL controllers
and reopening. This store alone does not activate a cloud review page, select a
ShareOne account, or connect comment events to an agent turn. Those host ports
must also enforce current model access before dispatch and delivery.
