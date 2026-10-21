# Agent HTTP integration standard — experimental profiles

This increment extends the existing Moss-owned `agent-federation.sudo.dev/v1alpha1` and external-provider read projections. SudoStack distributes exact owner bytes; Work consumes the pinned assembly. It is an experimental extension, not stable six-contract acceptance or full Enterprise 1.1/L2 delivery.

## Registration and dispatch

The existing `custom_http` catalog category now selects an adapter by the reviewed Manifest `protocol`. The persisted provider category is not the source platform or governance level. Existing Dify and legacy/durable HTTP registrations retain their behavior; no catalog CHECK constraint migration is required.

All protocols share the existing administrator onboarding, encrypted credential storage, review/publication, member ACL, version/channel selection, Task/Attempt/Session admission and unknown-result reconciliation. Metadata discovery and review never invoke an Agent. Every invocation repeats metadata verification before the existing atomic dispatch authorization check. A manifest does not grant authority.

Standard protocol manifests add `target`, `discovery_digest` and `conversation_mode: single_turn`. Endpoints, credentials and organizational authority remain outside manifests. Target is a model ID, an MCP tool name or the sole A2A skill ID, depending on the selected protocol. The digest binds the fetched model descriptor, selected tool descriptor or Agent Card respectively; it does not attest to remote code, prompt, weights or execution version. Descriptor changes require explicit re-import/review. The helper `discoverStandardManifest` produces this metadata without execution.

## Supported profiles

| Manifest protocol | Wire behavior | Actual supported scope |
|---|---|---|
| `agent-http.sudo.dev/v1alpha1` | Existing Manifest + `/invoke` | Legacy final-text HTTP; no remote idempotency guarantee |
| `agent-http.sudo.dev/v1alpha2` | Existing persistent run API | Existing idempotency, fixed execution revision and query-only recovery |
| `openai-chat-completions/v1` | `GET /v1/models/{target}`; `POST /v1/chat/completions` | One user text message, `stream:false`, `n:1`; one assistant text completion with `finish_reason:stop`. Model metadata endpoint required. No tools, refusal, truncated completion, Responses API or multimodal support |
| `mcp/2025-06-18` | Streamable HTTP initialize → initialized → tools/list → tools/call | JSON responses; one explicitly reviewed tool with a `query:string` input (optional length bounds); bounded discovery pagination. No arbitrary tool selection, resources, sampling, elicitation, SSE result parsing or stdio execution |
| `a2a/0.3.0` | Same-origin `/.well-known/agent-card.json`; JSON-RPC `message/send`, then `tasks/get` if needed | Single-skill Agent Card, `text/plain` input/output, Message or Task responses. At most 50 task polls, 100ms apart, within the shared invocation deadline. No push callback, task restart, streaming, file/data artifacts or human-input continuation |

For MCP, absent `additionalProperties` follows normal JSON Schema semantics; Moss still sends only `query`. The supported schema subset is checked and query length bounds are applied before dispatch. All three new profiles are stateless single-turn at the product level: the Work conversation retains history for the user, but history and remote context are not sent on the next request. An MCP transport session is never reused as a user conversation. A2A terminal tasks are never restarted.

All capability flags remain false for the new profiles. Polling an A2A task during one live invocation is not restart recovery. No UI or manifest may turn on unsupported streaming/cancel/resume/idempotency/version-pin/approval capabilities.

## Transport, outcome and evidence rules

- Existing pilot endpoint policy remains: literal-IP `http(s)://…/v1`, explicit organization allowlist, no redirects. MCP RPC uses this exact endpoint; A2A discovery uses its same origin at the standard well-known path and the Card URL must match the approved RPC endpoint. Alternative advertised URLs are never followed.
- Authorization is a separately configured bearer credential. No automatic OAuth flow, credential forwarding to discovered hosts or automatic auth retry is implemented.
- One total deadline spans discovery, dispatch and observation. JSON bodies are capped at 2 MiB and output text at 128,000 characters; MCP discovery is capped at ten pages, 200 tools/page. Unsupported JSON/SSE profiles fail explicitly.
- A W3C-shaped `traceparent` ties outbound requests to the Sudo task/attempt; local evidence retains `trace_id`. This is gateway correlation, not full downstream trace export or user-delegation proof.
- OpenAI completion IDs and A2A Message IDs are `provider_response_id`; A2A Task IDs are `provider_run_id`; MCP tool results have no fabricated run ID. Legacy Dify/HTTP still require their existing run handles. New outcome schemas permit absence of a run ID only for explicitly declared standard profiles.
- Optional OpenAI token usage is labeled `provider_reported`, never trusted Router billing. Other protocols do not fabricate token counts or zero cost. Invocation records permit call-count analysis; unified Router model cost attribution remains a separate management requirement.
- Explicit MCP `isError:true` or A2A failed/canceled/rejected terminal tasks produce local failed outcomes. Network loss, invalid response/correlation, protocol errors after dispatch or unsupported human-input states remain unknown in Moss. No automatic execution retry occurs, including after Moss restart.
- Stopping the local observation or closing an MCP session does not prove the remote work was canceled. Unknown runs use the existing manual reconciliation flow.

Existing registrations and evidence remain readable. Old clients that do not understand optional standard-protocol evidence must be upgraded together with this increment; deploy matching Moss/Stack/Work sources for these new registrations. This profile does not lift synthetic-only admission or add resources, attachments, production delegation, complete outbound data control or L2 hosting.

## Local reference agents

Run from the Moss checkout with existing Node/tsx dependencies:

```sh
node --import tsx scripts/agent-protocol-reference.ts http /tmp/my-agent-http
node --import tsx scripts/agent-protocol-reference.ts openai /tmp/my-agent-openai
node --import tsx scripts/agent-protocol-reference.ts mcp /tmp/my-agent-mcp
node --import tsx scripts/agent-protocol-reference.ts a2a /tmp/my-agent-a2a
```

Each process binds only `127.0.0.1`, chooses an available port, generates a random local credential and writes a private connection file and importable Manifest. Supply a fresh directory on every run; existing files are never overwritten. An optional last argument fixes the port. Without a directory, a fresh temporary directory is used. The credential is not printed. Ctrl-C stops that reference process. If Moss runs in Docker or on a different host, its loopback is different; this local-only fixture is intended for a host-local Moss, not a production service.

In Moss: enable the explicit synthetic pilot endpoint for the test organization, then open 专属智能体 → 外部托管 → 接入外部智能体 → 协议接入. Use the private connection file for endpoint/key, upload the generated Manifest, test the connection, grant a test member, review and publish. In Work: 智能体库 → 专属智能体 → select the Agent → send `6 * 7`. Expect `42`; standard-profile conversations display the single-turn limitation. Check the evidence for protocol, gateway trace and actual native handles.

The references execute deterministic arithmetic or return a prefixed input. They do not call a real model or imitate a deployed Dify/LangGraph installation. MCP uses the installed official TypeScript SDK (`McpServer` and Streamable HTTP transport), rather than a server built from the client decoder. OpenAI/A2A references implement the declared narrow profiles. Production interoperability with a third-party service needs separate evidence.

## Verification and specification sources

```sh
node --import tsx --test src/server/agentFederation/standardHttpAdapter.node-test.ts
node --import tsx scripts/e2e/agent-protocol-live.ts
```

The suite includes real HTTP calls, official MCP SDK interoperability, onboarding/review/ACL/Task persistence, revoke, descriptor drift, malformed identity, unsupported outputs and disconnect/restart without resend. The process smoke starts standalone reference servers from the CLI and removes its temporary credentials afterward.

- MCP 2025-06-18: <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports> and <https://modelcontextprotocol.io/specification/2025-06-18/server/tools> (retrieved during implementation).
- A2A 0.3.0: <https://a2a-protocol.org/v0.3.0/specification/> (retrieved during implementation).
- OpenAI Chat Completions reference: <https://platform.openai.com/docs/api-reference/chat/create>. Both official documentation hosts returned access blocks during this session; this profile uses the established Chat Completions subset already used in the codebase and a local conformance reference. Do not describe this as live OpenAI service verification or complete current API compatibility.

Remaining Enterprise requirements include genuine platform/L2 samples, trusted short-lived delegation, Router accounting/revocation across all paths, full tool/egress governance, inventory and migration evaluation. Local protocol success does not close those requirements.
