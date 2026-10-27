# Production session recovery acceptance

The operator probes use the same authenticated HTTP and WebSocket protocol as the product. `inspect-existing-product.ts` binds WebSocket credentials to the original session on either the local endpoint or the configured public TLS origin. It also preserves the public path prefix and permits only the configured instance routing parameter.

## Run against an isolated fixture

Build the portable existing-session probe with `bun run build:upgrade-check`. Build the explicit fixture producer with:

```sh
bun build scripts/e2e/create-product-canary.ts --target=node --format=esm --outfile=bin/moss-create-product-canary.mjs
```

Use an owner-only configuration containing the existing operator account, the actual controller port, and its configured public base URL. The fixture producer creates one co-host session, sends one real model request, and records its session and owner identity in private evidence. It logs out only its own token.

```sh
node bin/moss-create-product-canary.mjs /private/config.json /private/new-fixture
node bin/moss-inspect-existing-product.mjs /private/config.json /private/recovery --exercise-existing SESSION_ID --expected-binding /private/binding.json
```

Record the canonical binding of that exact new fixture before exercising it. The recovery probe checks two dependent replies, disconnects, resumes the same session, and checks a third reply using the earlier conversation. It verifies the original owner, Agent, durable session and repository binding.

After collecting the result, terminate only the newly created fixture through the normal product API or the explicit `--terminate-existing` probe action. Termination is permanent and does not restore a paused or resumable session.

## Verified on 2026-10-27

- Official Moss `server-v0.1.82` was installed on the production controller. Readiness and the adopted controller identity passed; existing browser containers and external Nexus processes were preserved.
- The older acceptance conversation retained its 16 messages, projected context hash and canonical Nexus binding across the upgrade.
- The previous loopback-only probe rejected the deployment's valid public `wss:` URL before sending a model request. The updated producer passed all 13 local regression tests, including origin, session, TLS, query and credential boundaries.
- A new isolated fixture passed one real seed request and three dependent recovery requests through the configured public TLS endpoint. Reconnection retained the same native binding. All eight resulting conversation messages were present before normal fixture termination.
- The private credential configuration was removed and all probe tokens were logged out. No controller policy or model configuration changed during the live journey.

The old fixture was formally terminated during an earlier cleanup attempt. Its subsequent recovery request returned HTTP 409, `Session was terminated`; this rejected recovery remains recorded separately. The successful new fixture establishes current production conversation and reconnection behavior. It does not establish model continuation of that old terminated fixture, a controller restart between these four requests, browser UI acceptance, or physical phone acceptance.
