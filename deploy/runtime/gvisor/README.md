# gVisor storage qualification

`runtime.lock.json` defines the upstream source, toolchain and exact backport
images. `build.py` verifies every downloaded input and both sides of the patch.
The backport makes the existing Gofer sync path return the first host error from
its write and read handles. Read handles carry directory namespace barriers and
can also represent existing files opened without a writer.

```mermaid
flowchart LR
  A[Verified upstream source] --> B[Baseline runtime]
  A --> C[Verified patch]
  C --> D[Candidate runtime and Gofer tests]
  B --> E[Host fault qualification]
  D --> E
  E --> F[Binary hash and qualification receipt]
  G[Pinned Nexus source] --> H[Storage test binaries]
  H --> I[Native and sandboxed recovery]
  D --> I
  I --> F
```

The [CI workflow](../../../.github/workflows/gvisor-storage.yml) builds the
baseline and candidate using the same source tree and toolchain. The upstream
`//:release` target assembles runsc, the containerd shim and all matching sidecars.
The release manifest identifies every executable, including the Sentry kernel.
The vendor release label follows gVisor's release-version format, enabling its
default sidecar version enforcement. Builds use the upstream AMD64 optimized
release configuration.
Compiler work uses Bazel file isolation, one job, reduced CPU priority and a
bounded container. The Go SDK source manifest determines the compiler and
analyzer inputs; upstream actions marked `no-sandbox` retain their explicit
local execution strategy. Actual Gofer tests
run at normal priority.

[The real runtime fixture](../../../scripts/e2e/gvisor-sync/qualify.py) injects
`EIO`, `ENOSPC` and `EDQUOT` into host `fsync` and `fdatasync` calls. Native
controls establish the injected errors. Both ptrace and systrap exercise
directfs and LISAFS with writable files, existing read-only files and
directories. Normal calls succeed; the candidate returns the original host
error. The baseline records the error-loss counterexample.

[The Nexus storage fixture](../../../scripts/e2e/gvisor-sync/nexus_storage.py)
runs the existing database and content-store suites first natively, then in all
four runtime/filesystem combinations. It covers concurrent creators, database
reopen, SIGKILL during initialization and publication, complete-content
publication, and file/directory barrier failures. The database suite invokes its
subprocess entry point for each crash phase.

Both fixtures accept `--platform` and `--filesystem` to qualify a deployment's
configured modes. CI uses their complete default matrix. The host's ptrace
policy governs Sentry's use of ptrace, including initialization under systrap.

`scripts/e2e/gvisor-sync/nexus-source.lock.json` pins the Nexus source. Its own
Rust toolchain and protobuf setup remain authoritative. Test executables are
built separately at reduced compiler priority and identified by a payload
manifest. Runtime execution uses the same release verifier, configuration and
log writer as syscall qualification.

Run the fixture on an isolated Linux machine with the namespace capabilities
needed by runsc. The release directory and its ancestors must allow search by
UID 65534, which starts the LISAFS Sentry sidecar. CI stages executables under
an owned `/tmp` directory. Private workspaces hold guest data and namespace
mounts; a separate results directory holds uploadable logs and receipts.
Its release manifest hash is an explicit input:

```sh
sudo python3 scripts/e2e/gvisor-sync/qualify.py \
  --runtime=/path/to/release/runsc --manifest=/path/to/release/manifest.json \
  --sha256=REVIEWED_MANIFEST_SHA256 \
  --results=/path/to/new-results
```

Each receipt identifies the executed bytes, fixture sources, platform and
observed syscall results. Deployment qualification also covers the backing
filesystem and device persistence, following the
[Nexus conditional-content contract](https://github.com/nexi-lab/nexus-vfs/blob/main/docs/conditional-content.md).
