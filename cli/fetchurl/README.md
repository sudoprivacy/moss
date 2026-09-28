# fetchurl — authenticated HTTP for skills, via the moss auth proxy

A small, zero-dependency Go binary that scode runs inside the moss runtime
container. It is a **curl-compatible** front end that routes a request through
the moss **auth proxy**, so the right per-user credential — or a freshly minted
short-lived access_token for login-type services — is injected automatically.
The skill author never handles credentials or proxy mechanics; they just name
the real service URL.

## Usage

```
fetchurl https://api.acme.com/v1/orders
fetchurl -X POST https://api.acme.com/v1/orders -H 'Content-Type: application/json' -d '{"sku":"A1"}'
fetchurl -i https://api.acme.com/v1/me            # include response headers
fetchurl -d @payload.json https://api.acme.com/v1/ingest
```

Flags (curl-like): `-X/--request`, `-H/--header` (repeatable), `-d/--data`
(`@file` reads the body from a file), `-i/--include`, `-h/--help`.

The upstream response (status, headers with `-i`, and body) is relayed to
stdout verbatim. A `4xx`/`5xx` upstream status makes `fetchurl` exit non-zero
(code 22), so a skill can detect failures — e.g. a `403 mint_failed` meaning the
user must set or refresh their credential in **我的凭据 (My Credentials)**.

## How auth happens

The proxy matches the target URL against a configured **凭据** (credential) and:

- **static credential** (API key / token / Basic): injects the user's stored
  secret directly; or
- **login-type service**: mints a short-lived access_token from the user's
  stored login credential (declaratively, or via a per-service script) and
  injects it — as `Authorization: Bearer`, or a custom header / query param
  (e.g. `Token: xxx`) as configured on the 凭据 — caching it per user+service.

Either way the raw credential stays server-side. For an unattended **cron**
task this "just works" — the token is re-minted from the stored credential each
time it expires, with no human present.

## Environment (set by moss-server when it spawns the session)

- `SUDOWORK_AUTH_PROXY_URL` — base URL of the auth proxy
- `SUDOWORK_AUTH_PROXY_TOKEN` — per-session bearer token binding calls to the user

## Build

```
cd cli/fetchurl
go build -o fetchurl .
```

The runtime image builds and installs it to `/usr/local/bin/fetchurl`
(see `deploy/runtime/Dockerfile`).
