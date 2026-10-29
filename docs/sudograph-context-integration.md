# Canonical model context at execution

The existing Moss ACP bridge supports Sudo Code's opt-in `hostContext` v1
protocol. An authorized host supplies `resolveHostContext` as a function in
`BackendSpawnOptions`; the cohost, local, Docker and legacy Kubernetes Sudo Code
backends pass it into the same bridge used for ordinary conversations. The
function is an internal runtime port. It is never
accepted from a prompt, HTTP request, client metadata or serialized manifest.

The closure binds one canonical project and rechecks current model access on
each read, including after asynchronous I/O. Its arguments identify the Moss
session and the engine's native session, not caller-selected model paths.
It returns the current deterministically compiled context as text. It must not
summarize a conversation into a competing definition or grant permissions based
on a prompt. Source credentials and worker paths stay behind the host boundary.

The bridge requires the engine to advertise v1 before creating or loading a
session. It opts that session into execution-time reads instead of sending an
initial mutable snapshot. Immediately before each actual model turn, the engine
requests the bound context through the existing ACP connection. The bridge
returns the newly read text followed by any fixed application role. Business
context is absent from user messages and their persisted history. Ordinary
sessions without the callback retain their existing static instruction behavior.

An unsupported engine, empty/malformed result or reader refusal cannot fall
back to a previous snapshot. A callback completing after interruption or
connection loss cannot disclose its text. Reader errors return an explicit
refusal without forwarding possible credentials. The engine refuses the turn
before making a provider request. No extra model workflow prompt or parallel
agent/renderer protocol is introduced.

## Acceptance and current limits

`acpHostContext.node-test.ts` is in the ordinary Node test runner. It covers
creation/resume negotiation, fresh reads, unchanged legacy sessions, rejected
capabilities, foreign session IDs, read failures and cancellation during reads.
The existing bridge and Nexus transport tests continue to exercise their shared
message and lifecycle paths.

The explicit acceptance below uses an installed compiler, a checksum-pinned real
engine process and the actual Moss ACP bridge. It registers a fresh SQLite
fixture, edits one canonical business definition, and captures complete provider
requests around the edit. It requires exact compiled context, matching graph
and context revisions, preserved user history, no business context copied into
that history, no model request after a synthetic host refusal, and unchanged
source bytes. A deterministic loopback provider needs no real API credentials.

```sh
node --import tsx scripts/e2e/accept-sudograph-context.ts \
  --engine /absolute/path/scode \
  --engine-sha256 "$SCODE_SHA256" \
  --python /absolute/path/installed-compiler/bin/python \
  --evidence /absolute/path/acceptance
```

Use the checksum from the selected, verified engine artifact. The evidence
directory retains captured requests, transcript, diagnostics and source/model
fixtures. A failed run does not create a successful receipt.

This port is not yet wired to a production cloud model registry. In particular,
adding a callback field does not carry a function through a durable manifest:
the owning runner must reconstruct it from a server-registered project and its
current authorization. The real-engine acceptance uses stdio, not a managed
Nexus mailbox, and its refusal is synthetic. Production tenant grants, worker
placement and credentials, WebUI routes, authenticated review/comment delivery,
published runtime adoption and the human journey remain separate acceptance.
The WebUI must not store a second canonical model or reinterpret a Desktop
SQLite path on its own host.
