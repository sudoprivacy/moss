# Shared browser review grants

`OntologyReviewGrantStore` implements the shared host SDK's grant interface on
the existing database driver. SQLite production initialization and PostgreSQL
migration 27 use the same schema. The store does not copy model definitions,
record data, ShareOne comment content or raw launch credentials.

A grant contains its project/conversation binding, credential hash, expiry and
an opaque authorization reference. `reviewAuthorizationRef` derives that
reference from the existing durable binding, including its organization, owner,
binding ID and project generation. It does not depend on the editable model
revision. Changing model definitions therefore preserves a grant; replacing an
owner or disabling and re-enabling a project changes or removes its authority.

The HTTP composition must return that current reference from the SDK's
authorization callback after checking current project, user, source and exact-read
policy. The database store itself is not a user/source grant. Every HTTP request
still checks current policy and the shared credential state before releasing a
result. There is no instance-local authorization cache.

Creation verifies durable ownership before and after its transaction. A global
primary key prevents ID reuse across organizations. Unique owner slots enforce
the fixed 128-active-grant limit under concurrent controllers without a separate
count/check race or in-memory lock. Expired owner slots are pruned on creation;
expired grants cannot be read or updated. Metadata updates compare the immutable
identity and only change the ShareOne connection or rendered revision. Deletion
revokes the capability across instances.

The existing browser gateway accepts asynchronous revocation and waits for it
before reporting a failed or uncertain navigation. Returning an error does not
leave the database revocation running in the background.

The SDK's embedded HTTP interface must be adopted from its accepted 0.1.3 release
before enabling production ingress. This database adapter does not itself expose
a public endpoint, install browser cookies or wire comment events into ordinary
chat. Those integrations retain their own current authorization and idempotency
requirements.

`createSharedModelReviewHost` composes this store with the existing production
model context/review ports and the shared SDK. Its private `open` method checks
the authenticated caller's current conversation ownership before issuing a
browser handoff. `handleRequest` mounts on the existing server, rechecks durable
binding and reviewed MCP/source policy, and uses the same conversation binding
for canonical reads. Closing an instance leaves its persisted grants available
to a replacement instance. The composition requires the existing comment
provider; it cannot silently fall back to a comments-disabled production page.
