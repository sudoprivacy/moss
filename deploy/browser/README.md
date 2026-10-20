# Managed browser worker

The public `ai-dev-browser` runtime supplies Chrome, its signed extension,
browser control lease and page/window display adapters. This private layer
binds them to authenticated Moss owners and conversations. The extension
signing key stays in BuildKit secret storage; profiles and credentials stay
outside the image.

SDK v0.58.1 owns the HTTP worker, persistent control journal, profile lease and
browser tools. `worker.py` only sets Moss's isolated X11 display, signed
extension directory and container Chrome arguments. The checked-in
`mcp-tools.json` is a pinned SDK manifest for allocation-free server discovery;
the consumer test verifies it against the installed public package.

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
- `MOSS_BROWSER_ALLOWED_OWNERS` (optional): a JSON array of exact
  `{"orgId":"...","userId":"..."}` pairs. Set it for the initial restricted
  rollout. Other owners receive no built-in browser MCP grant and cannot use
  either the viewer gateway or MCP entry. `[]` disables every owner; leaving
  the setting unset enables every otherwise authorized owner. Malformed
  settings refuse server startup.

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

## Explicit lifecycle

`browser_launch` requires a launch mode and keeps an existing browser in that
mode. A different mode returns `browser_restart_required`.
`browser_restart` requires current control/target epochs, explicit transport
and headless choice, and `acknowledgeStateLoss: true`: unsubmitted page state
can be lost. It closes the owned Chrome, preserves its profile and login
cookies, starts the chosen mode and returns a fresh observation. Old input
coordinates and frames are fenced before closing any resource.

`browser_stop` releases Chrome and its display while keeping the profile.
Every main/child call shares the same control lease. AI cannot stop, restart
or relaunch a browser held by the human. After a human stop, Return to AI can
release control while Chrome stays stopped; a subsequent task decides whether
to launch it. Failed or uncertain shutdown keeps automation fenced and requires
explicit recovery instead of replaying the request.

`test_lifecycle_live.py` runs the actual HTTP/MCP journey. Native runs use CDP;
the managed-browser CI image verifies CDP and signed extension mode, including
headless-to-headful restart, persistent login, stale requests, human stop and
return without relaunching Chrome.

Concurrent Stop and status polling retain the human lease. During lifecycle
transitions the public worker reports `pausing` and disables page/window
capabilities instead of querying a retiring driver. The consumer journey
checks concurrent HTTP status reads during actual Chrome shutdown. Ordinary
concurrent status reads keep the human controller, page capabilities and target
epochs unchanged, so viewer polling cannot interrupt typing or file selection.

Workers run as UID 10001 with a 1.5 GiB memory limit, 1.5 CPUs, a PID limit,
dropped capabilities and no new privileges. Limit enabled accounts during
initial rollout: this registry does not yet implement global admission limits
or automatic idle eviction. A worker image change requires a drained profile
and explicit replacement of its owned container while preserving its volume.

## Files in the shared browser

Public SDK v0.56.0 supplies the native file-chooser and completed-download
primitives. The worker stores bytes inside its isolated persistent volume.
Viewer upload/download routes recheck the current owner and active account;
the agent credential cannot call the host byte-transfer endpoints.

A user stages a file through the authenticated host, then attaches its opaque
ID to the current chooser using `upload-files`. Both operations use the same
human control and target epochs. A handoff, replaced chooser or target change
rejects the old request without replay. Agents can attach IDs supplied by the
host after control returns; they cannot provide arbitrary filesystem paths.
The existing page-command allowlist excludes raw `DOM.setFileInputFiles`.

Uploads are limited to 16 MiB per file and 20 files per chooser. Metadata
contains only the opaque ID, filename, size, SHA-256 and kind. Downloads appear
after completion and stability checks; the authenticated read verifies their
size and hash again. Profile restart retains the files and their IDs.

The managed extension needs Chrome's file-access permission for native upload.
Only the worker's provisioned isolated profile receives this setting, while
Chrome is stopped. Ordinary attached user profiles keep their existing
permissions. The public provisioning helper verifies the exact extension ID
and Chrome's actual setting before starting the shared session.

`test_files_live.py` performs real trusted file selection and download in both
CDP and extension modes, including Unicode filenames, stale control, owner
isolation, agent/host credentials, exact bytes and restart persistence. The
managed-browser workflow runs it with the lifecycle suite.

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
