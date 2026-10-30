# Reviewed human model reads

The compiler worker advertises `moss/host-review-profile` with value
`sudograph-worker-review/v2` on its exact-read tool. This metadata is part of
the existing reviewed descriptor digest. Upgrading a worker requires the normal
descriptor review; an old or missing profile cannot silently enable private
HTTP reads. Ordinary context-only tools retain their existing contract.

`McpOntologyReviewPorts` requires current context/project access and the separate
exact-read approval for every human review operation. Non-page requests authorize
that tool's schema and full-model read classification without inventing a record
pointer or invoking the tool. Page requests also validate their actual revision,
digest, target and record arguments. The normal agent MCP path still validates
its actual arguments and retains its existing result limit.

The client reuses current membership, server/source visibility, effect policy,
secret resolution and reviewed descriptor fencing before and after network I/O.
Production composition additionally checks the durable conversation/project
binding on both sides. Disable/re-enable generation changes, changed session
owners, replaced reviews and credential or policy revocation discard results.
Access audits retain metadata only; an unavailable audit also refuses delivery.

The private HTTP request resolves its endpoint next to the registered MCP
endpoint and uses the same checked network transport, credential headers and IP
policy. There are no discovery redirects, proxy fallbacks or caller-selected
hosts. Human JSON responses have a separate fixed 32 MiB ceiling, with 64 KiB
error bodies. Model/MCP transport bounds remain unchanged. Only known protocol
error codes and host-owned recovery text are returned from upstream failures.

The registered Moss project ID and the worker model name are distinct identities.
The host supplies its project ID as the compiler's rendering resource, while the
model, source and actor remain deployment bindings. Calls to the review port
cannot supply this resource themselves. Version 2 responses echo `resource_ref`
alongside authority, model, source references and full-model scope; the client
checks every identity before returning a result. Thus generated HTML and its
subsequent reads use the same project ID without changing canonical object IDs.

Acceptance covers the actual shared review host, reviewed HTTP/MCP path, published
compiler and SQLite records, plus authorization changes, stale descriptors,
identity mismatches, bounds and cancellation. This is the host read interface;
public browser routing, shared review grants, ShareOne credentials and ordinary
chat delivery still require their separate composition. The profile supports a
complete registered model; it does not claim new row/field scope support.
