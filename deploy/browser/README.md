# Managed browser worker

The public `ai-dev-browser` runtime supplies Chrome, its signed extension,
browser control lease and page/window display adapters. This private layer
binds them to authenticated Moss owners and conversations. The extension
signing key stays in BuildKit secret storage; profiles and credentials stay
outside the image.

SDK v0.58.13 owns the HTTP worker, persistent control journal, profile lease and
browser tools. `worker.py` only sets Moss's isolated X11 display, signed
extension directory and container Chrome arguments. The checked-in
`mcp-tools.json` is a pinned SDK manifest for allocation-free server discovery;
the consumer test verifies it against the installed public package.

The managed-browser workflow builds the SDK v0.58.13 base, applies
`chrome-version.Dockerfile`, then builds this worker. The Chrome layer downloads
the versioned official package, verifies its SHA-256 before installation and
checks the installed package version. The current runtime uses Chrome
156.0.8078.73. The upstream base still downloads `stable_current`; the version
pin applies to the final runtime, not every intermediate build dependency.

The controlled command tool supports a bounded optional `frame` selector for a
descendant of the selected tab. The SDK resolves it for both native CDP and the
managed extension while retaining human input leases and operation epochs.
Moss forwards the original MCP arguments and advertises the same pinned schema
before allocating a worker. The workflow checks the installed package catalog
offline and verifies the first frame command after signed profile upgrade and
crash recovery.

Keep this update in draft until the public SDK release is available and its
exact artifact has passed qualification. A candidate image test does not publish
the package or upgrade the running Moss service.

The integrated candidate with Chrome 156.0.8078.73 passed twenty actual Linux
browser cases, with two existing fixture skips, and the signed profile upgrade
and forced-crash recovery journey. The first frame command, extension identity,
ordinary and HttpOnly cookies, and input exclusion survived both recoveries.
This is candidate evidence; the released package and production promotion still
require their own acceptance.

This patch adds bounded selection drag, selection text and multiline paste over
the existing authenticated input channel. Copy reads the active page selection;
it does not expose the VM clipboard. Headful launch uses a child-only X11
environment, so closing a managed browser does not alter later native launches.

## Conversation workflow

The host adapts launch guidance during MCP discovery: the agent asks for human
help through native questions or ordinary conversation. SudoWork uses its
existing interrupt and a fresh chat message, with no separate browser
takeover/return buttons.

`POST /api/v1/sessions/:id/browser/conversation` accepts only
`{ "intent": "interrupt" }` or `{ "intent": "continue" }`. It rechecks the active
owner, changes only an existing browser bound to that exact conversation, and
never allocates a profile or claims one from another conversation. An authorized
manager can continue chat without acquiring the owner's browser. Interrupt
acquires the SDK's acknowledged input lease; continuation drains input and
freshly observes before releasing it. It sends no synthetic model turn.
An uncertain transition remains blocked and is never automatically replayed.
Deploy this server endpoint before clients that use the conversation workflow.

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
- `MOSS_BROWSER_OWNER_IMAGES` (optional): a JSON array of exact
  `{"orgId":"...","userId":"...","image":"sha256:<digest>"}` entries.
  Each image must be immutable, and a default `MOSS_BROWSER_IMAGE` is required.
  Duplicate owners, unknown fields and malformed entries refuse startup.
  An image pin selects the runtime for that owner; it grants no browser access.

For staged upgrades, keep existing owners pinned to their current immutable
image while an isolated acceptance owner uses the new image. Change the default
after acceptance, retaining old pins until those owners have explicitly drained
their browsers. The registry checks the selected image before starting or
connecting a container. A mismatch still returns `409` and requires a drained
profile; it never replaces a running browser, resets a human lease or migrates
a profile automatically. Remove an old pin only after the supported drain and
upgrade procedure. Settings are read when the registry starts, so deploy the
same configuration to every server instance.

All server instances serving this registry must use the same Docker host and
deployment secret. A distributed browser owner service is required before
spreading browser workers across independent Docker hosts.

The existing explicit endpoint settings support isolated integration fixtures.
Use the per-owner registry for a multi-user deployment.

`browserOwnerImages.live.ts` exercises this rollout with two actual Docker
images and fresh owners: the old browser keeps its cookie, container and human
epochs, a new owner uses the default image, an unpinned mismatch is refused,
and normal conversation continuation resumes the original profile. The managed
browser workflow runs it with the current and signed legacy Chrome images.

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

### Optional read-only window stream

The new `window-stream` browser action and
`/ws/sessions/:sessionId/browser/window?viewerId=...&controlEpoch=...&targetEpoch=...`
upgrade adapt the public worker's read-only RFB transport. The host validates
the exact personal owner and current account access before opening the worker
connection, before forwarding binary messages in either direction, and during
idle periods. Revocation closes both sockets. Per-connection message and queue
limits bound slow viewers; a failed handshake is returned without reconnecting
or disclosing internal endpoints.

The WebSocket uses the existing authenticated server upgrade route. Public
browser clients must use the WebUI's session-authenticated proxy; they must not
receive a Moss bearer token or a privileged worker header. Only an existing
worker/profile bound to that exact task can stream. Opening a socket does not
allocate a worker, claim an ended task's profile or release human control.

VNC carries pixels and protocol negotiation. Keyboard, pointer and clipboard
writes remain server-disabled in the public worker and use the ordinary
epoch/lease-checked browser action API instead. This preserves conversation
interrupt and native agent communication without adding business handoff
buttons. The new worker capability is optional, so older workers continue to
offer the existing JPEG/native-input path.

This source adapter pins SDK v0.58.11, tagged from merged SDK PR #44, and the
managed-browser workflow uses its matching source commit. Public artifact
verification, the shared renderer and WebUI proxy, actual public graph/phone
acceptance and production rollout remain separate delivery gates. Local real
WebSocket proxy tests are not public end-to-end acceptance. Both proxy hops
test a first RFB banner coalesced with the HTTP upgrade: the upstream stays
paused until both relay directions are installed, so no banner is lost while
the caller resumes asynchronously.

The SDK supports a host-authorized review-page bootstrap for managed CDP and
extension sessions. Personal Chrome attachments retain their own authorization
boundary. Product review-page launch still requires the host authorization and
Moss adapter integration described by its separate acceptance gate.

Page drag support is negotiated through `liveDragSurfaces`. The shared worker
streams checked page input while keeping page pixels readable during the
gesture. Control and target changes fence in-flight frames, and viewer loss
releases the held button without returning automation control. Managed-browser
CI exercises the installed public worker's page-drag journey with both CDP and
the signed extension, alongside the existing window-stream coverage.

The public 0.58.11 image was built through this Dockerfile and qualified with
Google Chrome 156.0.8078.47. Six real Moss HTTP/MCP lifecycle and file cases and
six SDK page/window drag cases passed in isolated containers with one CPU,
1536 MB memory, 384 PIDs and init enabled. This qualifies the image; production
owner promotion, public graph latency and physical phone input remain separate
gates. Existing active tasks and persistent profiles must survive promotion.

`browser_launch` requires a launch mode and keeps an existing browser in that
mode. A different mode returns `browser_restart_required`.
`browser_restart` requires current control/target epochs, explicit transport
and headless choice, and `acknowledgeStateLoss: true`: unsubmitted page state
can be lost. It closes the owned Chrome, preserves its profile and login
cookies, starts the chosen mode and returns a fresh observation. Old input
coordinates and frames are fenced before closing any resource.

`browser_stop` releases Chrome and its display while keeping the profile.
Every main/child call shares the same control lease. AI cannot stop, restart
or relaunch a browser held by the human. After a human stop, the host's ordinary
continuation flow can release control while Chrome stays stopped; a subsequent task decides whether
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
then graceful and crash recovery. The fixture image uses the unchanged public
v0.54.0 extension on Chrome 155.0.8059.84 and its earlier bootstrap contract,
then upgrades to the current worker on Chrome 156.0.8078.73. Installed versions,
signing identity, original cookie and human lease are checked against Chrome's
actual state; containers and volumes carry unique ownership labels and are removed.

For a candidate with controlled child-frame commands, add `--verify-frames` to
that same runner. It waits for an actual cross-site iframe load and sends one
MCP frame command after both graceful image upgrade and crash recovery. A
separate HttpOnly fixture cookie is set only by the first container; later
containers must receive it without exposing it to page JavaScript. Use a new
`--output` path for each run so earlier failures remain available. The default
journey remains compatible with the legacy public SDK fixture.

### Pre-launch MCP discovery

Moss advertises browser tools before a browser task starts, without allocating a
worker or claiming a profile. Its `mcp-tools.json` is a generated snapshot of the
SDK catalog. After installing the intended SDK, run
`python deploy/browser/verify_tool_catalog.py --update` to regenerate it.
The managed-browser job checks this snapshot against the SDK actually installed
in the worker image, with networking disabled and no Chrome process. Update the
SDK pin and its catalog together. This keeps parameters such as child-frame
selectors discoverable to the model while the host retains its launch guidance.

`test_worker_live.py` validates the actual Chrome/HTTP control boundary.
`test_agent_live.py` and SudoWork's `live_browser_handoff.py` cover configured
real model journeys. Run those locally with vault-backed test accounts before
delivery; keep credentials outside the repository. A primitive browser test
does not establish application, model or production acceptance.
