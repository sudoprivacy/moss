# Cloud review composition

`createCloudModelReviewService` composes the existing registered-model host,
shared SQL grants and review inbox, personal Secrets API, native conversation
channel and authorized browser gateway. It does not create another model,
credential store, renderer or chat. The server must supply its deployed HTTPS
origin, installed pinned ShareOne assets, current account check and existing
runtime/browser/secret services. Pages and agent inputs cannot select those ports.

The service returns `handleRequest` for the existing HTTP listener, `open` for
the authenticated owner's already-started browser, and `close` for host shutdown.
The private launch cookie goes only through `openSessionAuthorizedPage`; it is
not returned as an agent tool result or a frontend credential. Each read checks
the current account, registered model binding, reviewed worker access and grant
generation. The existing gateway enforces current browser ownership and epochs.

The comment provider resolves the actual bound conversation for model heads and
native input. It shares the organization-scoped SQL inbox and permanent dispatch
reservations. Owner providers are initialized once per host, while each credential
read goes through the existing personal `user:{userId}:shareone` Vault namespace.
Pairing writes `shareone_key`; compatibility reads and logout use the same aliases
as Desktop. A current access failure cannot return a cached key or fall back to
a shared enterprise credential. ShareOne continues to enforce its own current
owner/collaborator policy.

Comment dispatch requires the published SDK 0.1.4 or newer bound-conversation head and
atomic reservation protocol. An older SDK cannot dispatch through this service:
missing conversation identity returns an explicit upgrade error. Native recovery
also requires the runner's advertised receipt protocol before any control input.
Unknown outcomes retain their reservation and require reconciliation.

## HTTP deployment

The normal Moss listener mounts the private `/review/{grant}/` surface before
bearer authentication. The shared host instead verifies its grant cookie,
deployed origin, current owner and reviewed model access on every request.
No Moss access token is embedded in the page. Other API routes retain ordinary
authentication.

`POST /api/v1/sessions/{conversationId}/ontology-review` accepts exactly
`{ "controlEpoch": 3, "targetEpoch": 4 }`, the generations observed in the
existing browser panel. It uses the authenticated account and registered session
binding, opens the page through the private browser gateway and returns only
`{ "surface": "viewer", "conversationId": "..." }`. It cannot select a model,
source, URL, asset directory, credential or another owner. The existing browser
must already belong to this conversation; stale generations and uncertain
navigation revoke the new grant instead of falling back to public navigation.

Set `MOSS_MODEL_REVIEW_ASSETS_DIR` to the installed, pinned ShareOne review-shell
directory, and set `MOSS_PUBLIC_BASE_URL` to the deployed HTTPS origin. The
existing Nexus personal Secrets API is required. `MOSS_SHAREONE_ORIGIN` defaults
to `https://shareone.vip`. Asset, origin or credential-service configuration
errors prevent the configured server from listening. With no asset directory,
the feature is disabled and review requests return an explicit 503.

The normal host build stages the original frontend from the locked SDK into
`bin/model-review-assets/`. Container and host-release packages carry that same
directory, the registered compiler worker and a bundled asset verifier. For the
container, the configured resource path is `/app/bin/model-review-assets`; for
an extracted host archive, use the absolute path to `app/bin/model-review-assets`.
Bundling the server does not resolve a second frontend through `import.meta.url`
or require a ShareOne source checkout in production. The build validates hashes
before replacing its prior output and includes only manifest-listed assets and
their source receipt. Archive acceptance runs the bundled verifier against the
extracted resource bytes. Carrying resources does not enable the feature or grant
access; the existing deployment, current-owner and Nexus requirements still apply.

Host replacement retains page grants, subscriptions, inbox state and execution
reservations in the shared database. Delivery-status polling restores the new
process's comment watcher even when the page already has its ShareOne identity.
Repeated polls reuse that watcher. Neither account credentials nor model contents
are cached as a substitute for their authoritative services.

The adopted SDK is the verified official 0.1.5 release, including the original
pinned ShareOne frontend. Packaging checks load its installed bytes through the
same bundled verifier used for the extracted host archive. Registered acceptance
also exercises real HTTP, reviewed MCP access, SQL grants/inbox/reservations,
native TCP input, the ordinary ACP bridge and transcript, provider reply routing,
duplicate events and host replacement. ShareOne, engine output, browser and
credential ports remain fixtures in that service acceptance; its minimal frontend
is explicitly a transport fixture. The client entry is implemented, while live
Nexus/ShareOne access and comment-to-live-LLM browser acceptance remain deployment
work before enabling this experience for users.
