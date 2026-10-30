# Reviewed MCP input profiles

Tools keep the existing closed scalar-object input profile unless their
descriptor explicitly declares a supported extension. Unsupported objects,
references and schemas remain rejected by default.

`_meta["moss/input-profile"] = "bounded-record-v1"` adds optional or required
JSON record fields alongside the existing scalar fields. The descriptor must
declare each record as `type: "object", additionalProperties: {}`; the standard
unrestricted-string `propertyNames` emitted by Zod is also supported. Structured
object schemas, top-level array fields, schema references and unknown constraints
are not added by this profile.

The host checks the schema during IT review and checks arguments again before
dispatch. All records share fixed limits: 32,000 bytes total arguments, six levels of
nesting, 256 JSON values, 32 keys per object, 100 items per array, 8,192 characters
per string and 128 characters per record key. Values must be plain JSON. Empty or
control-character keys, prototype-sensitive keys, non-finite numbers, class
instances and cyclic structures are rejected. The scalar field bounds, required
keys and closed root object remain enforced.

Profile metadata is part of the descriptor digest stored in the existing review.
It does not approve a tool or grant access. Changing or removing it fences the
old review until the new descriptor is approved through the existing process.
Task grants, current membership, server/source policy, effect classification,
credentials, duplicate-call handling and the 128 KB output limit are unchanged.
Unknown profile versions fail explicitly without falling back.

The Sudograph worker declares this profile for `sudograph_context_read` because
its checked subgraph selection is a JSON record. The actual published descriptor
is validated in worker acceptance; the ordinary gateway HTTP/MCP acceptance
checks review, dispatch, rejection before dispatch and descriptor changes with
an unrelated record-reading tool. No model prompt or dataset-specific rule
selects the profile.

Trusted host readers use the same descriptor review and argument checks as
other MCP dispatch. An argument-bearing read requires its own approved read
descriptor; approval of a context-only tool does not approve record access.
The host snapshots the selection before asynchronous authorization, then
rechecks current membership, credentials, server policy and the reviewed
descriptor before dispatch and after receiving data. Caller cancellation also
prevents dispatch or delivery. This host interface does not replace the task
grant gate for agent calls, add row/field permissions, or enable a public
review page by itself.
