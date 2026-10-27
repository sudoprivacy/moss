# Runtime maintenance admission

Compute maintenance starts by pausing new Session work and waiting for accepted
work to settle. Moss uses `WorkAdmission` from `@sudo/user-runtime` for Session
creation, recovery, placement updates, channel messages, cron, event and Wiki
claims. An accepted job retains its admission through nested calls and its
authenticated internal WebSocket. The local continuation expires with that job.

## Operator API

These routes require a current super administrator. Preparation supports one
live Moss controller; a live peer makes the request fail before pausing.

1. `GET /api/v1/admin/runtime-admission` returns `instanceId`, `epochId`,
   `isPaused`, `activeOperations` and the current `pauseIds`.
2. Choose a UUID and `PUT /api/v1/admin/runtime-admission/pauses/<uuid>` with
   `{ "instanceId": "<observed instance>", "epochId": "<observed epoch>" }`.
3. Accept preparation only when the response has `isInputDrained: true` and
   retains that pause ID. An HTTP 409 means preparation failed. Busy,
   unavailable or unjoined work releases only this request's pause.
4. `DELETE` the same URL with the same body to resume that holder. Other
   operators' holds remain effective.

Repeating a PUT joins the same preparation. The epoch changes with the gate's
lifetime, including when a restarted controller reuses its configured instance
name. Pauses and continuation grants live in memory. A restart requires a new
preparation; a stale request cannot release a different epoch's fence.

Preparation joins admitted operations and asks every tracked consuming daemon
to hold new input. Each daemon flushes and closes its earlier client streams,
then checks backend readiness and activity. This also covers a browser that
has already disconnected. The controller retains the daemon's control channel
until release. An unsupported protocol, changed runner set, missing activity
or timeout refuses preparation. A busy refusal leaves the existing task running.
Native input remains busy during artifact preparation and while awaiting engine
admission. A preparation failure releases that activity; an accepted handoff
continues to follow the engine's activity.
The consuming runner's recorded creator must match this controller, including
an automatically assigned instance ID. A missing or unreadable manifest refuses
maintenance preparation. Readiness returns 503 while a hold remains. An
unconfirmed daemon release keeps the controller hold visible so the operator
can retry the same DELETE.

## Compute acceptance

`isInputDrained` describes this controller's inputs. Before stopping compute,
inspect every owner's native executions, approvals and background tools, plus
physical writers outside those executions. Recheck the same controller, epoch,
pause ID and Pod identities immediately before the operation. Unavailable or
untracked work requires investigation. A Kubernetes `Failed` phase alone does
not prove that its old process has stopped.

After the full drain, take consistent control-store and retained-volume
backups, retain the disks and PVCs, and perform the approved maintenance.
Recovery must preserve native Session IDs, history, files, Agent memory and
latest-session selection. Interrupted tool outcomes retain their uncertainty;
operator acceptance must check that original inputs and tools were not replayed.
