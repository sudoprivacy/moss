# Terminal user runtime upgrade

`@sudo/user-runtime` 0.2.1 replaces an owned `Succeeded` or `Failed` Pod without
waiting for that terminated process to answer mTLS requests. Service, Secret,
Pod UID and owner checks still run. The replacement must pass authenticated
readiness and release verification before the upgrade succeeds.

## Live fixture

`scripts/e2e/qualify-terminal-user-runtime.ts` exercises the installed public
SDK with the production Moss readiness adapter and a real Kubernetes cluster.
The PR and release workflow compile this entrypoint against the installed SDK.

Run it only with an authorized, isolated allocation and the existing Moss
runtime issuer environment. Pass `--execute` and supply JSON through stdin:

```json
{
  "ownerId": "<test owner UUID>",
  "allocationId": "acceptance-terminal-<unique suffix>",
  "terminalPhase": "Failed",
  "output": "/private/acceptance-proof.json",
  "userPod": {
    "image": "<reference in MOSS_RUNTIME_MANIFEST_PATH>",
    "nodeHost": "<runtime host>",
    "namespace": "<namespace>",
    "kubeconfig": "<existing runtime kubeconfig>",
    "storageClass": "<storage class>",
    "storageSize": "1Gi"
  }
}
```

Preserve any deployment-specific runtime class, resource limits and image pull
settings in `userPod`. The fixture refuses pre-existing resources. It starts a
real authenticated native runtime, then replaces its own Pod with a container
that writes a marker into the same PVC and exits with code 0 (`Succeeded`) or
17 (`Failed`). It calls the installed SDK's upgrade path and verifies:

- A new Pod UID and authenticated replacement readiness.
- The same PVC UID and retained marker.
- No drain request to a terminated runtime.
- Native runtime and image verification through the release manifest.

The fixture makes no model calls. Its `finally` block stops its replacement
Pod; it deliberately retains Secret, Service and PVC for explicit cleanup.
Select a cleanup identity with the needed permissions **before** running.
Remove only resources matching the proof's exact name, owner, allocation and
UID, after checking no Pod references the claim. Record cleanup separately.
Never select a user's primary allocation or delete its retained workspace.

## Acceptance evidence

On 2026-10-27, both terminal phases passed against official native runtime
0.1.83 and the production mTLS readiness adapter. Each case retained its PVC
and marker, removed its fixture Pod, and left the primary test owner's Pod,
PVC, Secret and Service UIDs unchanged. All six retained fixture resources
were removed using the cleanup identity selected before testing. The SDK
regression suite also covered terminal ownership rejection and active-runtime
draining; public release files were verified against the tested build.
