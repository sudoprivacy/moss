# Managed browser worker

The public `ai-dev-browser` runtime supplies Chrome, its signed extension,
browser control lease and page/window display adapters. This private layer
binds them to authenticated Moss owners and conversations. The extension
signing key stays in BuildKit secret storage; profiles and credentials stay
outside the image.

## Configuration

Set these on the Moss server:

- `MOSS_BROWSER_IMAGE`: a validated image digest, such as
  `registry.example/browser@sha256:<digest>`. Mutable tags are rejected.
- `MOSS_BROWSER_SECRET`: a persistent deployment secret of at least 32
  characters, loaded from the deployment vault. Keep it stable across restarts.
- `MOSS_BROWSER_AGENT_BASE_URL`: the authenticated Moss API origin reachable
  from its agent runtimes. Attempts receive a narrowly scoped HTTP MCP grant.
- `MOSS_BROWSER_NETWORK` (optional): a Docker network shared with Moss.
  Without it, worker APIs publish on host loopback with ephemeral ports.

All server instances serving this registry must use the same Docker host and
deployment secret. A distributed browser owner service is required before
spreading browser workers across independent Docker hosts.

The existing explicit endpoint settings support isolated integration fixtures.
Use the per-owner registry for a multi-user deployment.

## Lifecycle and access

MCP initialization, ping and tool discovery allocate no worker and claim no
profile. An actual browser tool call or owner view creates a worker on demand.
Each organization/user pair has its own named persistent volume and exclusive
profile lease. A second active conversation cannot silently steal that profile.
After the previous conversation ends, the next conversation can continue with
the same Chrome and cookies. Human control survives that transition and crash
recovery; returning to AI always requires a fresh observation.

The host and agent credentials are distinct. Account, organization, owner and
current attempt are checked on every request. Host credentials, the deployment
secret, profile paths and raw Chrome endpoints are never injected into agents
or returned to viewers. An agent grant becomes invalid when its attempt ends.

Headless tasks start no display process. Headful tasks start a dedicated Xvfb
display and Openbox window manager through the public `XDisplay` adapter.
Page and full Chrome window frames travel through the existing
authenticated gateway. Native window input uses the same control lease; it
follows the user's selected tab and invalidates old coordinates. Display
adapters are acquired only while viewers are attached. Viewer disconnects
retain Chrome, cookies and any human lease.

Takeover fences new AI browser operations immediately and drains the operation
already in progress. This gate covers all agents using the shared worker.
Other agent tools have their own execution policy. Automatic return sends one
handoff note through the normal authenticated conversation channel. A lost
acknowledgement is reported and never retried.

Workers run as UID 10001 with a 1.5 GiB memory limit, 1.5 CPUs, a PID limit,
dropped capabilities and no new privileges. Limit enabled accounts during
initial rollout: this registry does not yet implement global admission limits
or automatic idle eviction. A worker image change requires a drained profile
and explicit replacement of its owned container while preserving its volume.

## Acceptance

`browserWorkerRegistry.live.ts` exercises the actual Docker registry, signed
extension, separate user cookies, conversation transfer, stale attempts and
restart recovery. `.github/workflows/managed-browser.yml` runs it in CI.

`live_docker.py --prior-image OLD --image CURRENT --output evidence.json`
also verifies a real signed extension upgrade in the same persistent profile,
then graceful and crash recovery. The fixture image uses the public v0.54.0
extension and its earlier bootstrap contract. Installed versions, signing
identity, original cookie and human lease are checked against Chrome's actual
state; containers and volumes carry unique ownership labels and are removed.

`test_worker_live.py` validates the actual Chrome/HTTP control boundary.
`test_agent_live.py` and SudoWork's `live_browser_handoff.py` cover configured
real model journeys. Run those locally with vault-backed test accounts before
delivery; keep credentials outside the repository. A primitive browser test
does not establish application, model or production acceptance.
