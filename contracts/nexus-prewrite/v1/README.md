# Nexus pre-write receipt consumer

The schema and fixture are exact projections of nexus-vfs via SudoStack. Validate
both pinned Git object hops with `node scripts/contracts/nexus-prewrite-source.mjs
--stack <sudostack checkout> --owner <nexus-vfs checkout>` (on one command line).
The ordinary test runner checks local snapshots and negative source-lock cases;
the Provider build refuses snapshot drift.

Only nexusModelExecutor's Write catch can recognize this receipt. It verifies
schema, permission code, hook, reason, current path and original bytes digest over
the configured mTLS channel. Unsupported/absent/mismatched data remains unknown.
Private Provider evidence commits atomically with failed state and retires after
30 days with the run payload. Moss receives only an allowlisted provider-reported
reason through existing AgentRun.error_code; this is not a Moss policy verdict or
an end-user delegation attestation. Work uses the same existing task error field.

An updated executable changes execution_revision. Publish and review its new
manifest/version through the existing administration flow. This does not retarget
old versions, promote a channel on GET, or requeue existing unknown runs. Old
kernels omit the receipt and continue yielding unknown for their write failures.
