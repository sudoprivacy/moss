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

Comment dispatch requires the published SDK 0.1.4 bound-conversation head and
atomic reservation protocol. An older SDK cannot dispatch through this service:
missing conversation identity returns an explicit upgrade error. Native recovery
also requires the runner's advertised receipt protocol before any control input.
Unknown outcomes retain their reservation and require reconciliation.

The service is a host composition API. The production HTTP route, installed
frontend packaging, SDK adoption and Desktop/WebUI client entry still need to be
connected before enabling it for users. Its HTTP/MCP/SQL transport acceptance uses
credential and browser ports and a minimal asset fixture; it does not establish
live Nexus/ShareOne storage, actual browser interaction, or comment-to-live-LLM
acceptance. Those remain separate deployment acceptance work.
