# Existing Edge database qualification

The Edge product deploy reuses its existing Moss/cohost installation. The
shared orchestration belongs in sudostack and device parameters in sudoedge;
Moss owns its database schema and migration checks. Running the current k3s
installer against a custom external-cohost installation is a different
migration and does not qualify this path.

Before replacing the existing controller, run this source's database-copy
journey with Node 22.21 or later:

```sh
node --import tsx scripts/e2e/qualify-sqlite-upgrade.ts /absolute/current/moss.db
```

The source is opened read-only. The SQLite backup API creates a consistent
private copy, including committed WAL records. Only that copy is opened by
`DirectConnectStore`. The check requires database integrity, no foreign-key
violations, preservation of every existing table's columns/rows, and an
idempotent second open. It reports hashes/counts, without printing database
values or prompts. A legacy conversion that deliberately removes columns or
changes existing values requires its own reviewed mapping; this check does
not silently accept it. More than 100,000 rows in one table requires a
separately reviewed larger-data qualification.

This program starts no server, controller, managed execution or model request.
Its private copy is removed afterward. The in-repository process tests cover
source-file preservation, committed WAL data with the source still open, and
refusal of an invalid database without repairing the original.

`bun run build:upgrade-check` builds only the self-contained Node checker at
`bin/moss-qualify-sqlite-upgrade.mjs`, using the same production bundle settings.
The normal build also includes it in `bin` for a producer release. On an offline
target run `node /pinned/bin/moss-qualify-sqlite-upgrade.mjs /absolute/moss.db`;
no compiler, package installation or new service is required. Bind the receipt
to the source and generated bundle hashes. Dependency/source equivalence must
be established before using an older producer artifact's migration result.

A pass is not a service drain, native cohost-data migration, history recovery,
runtime rollback, owner credential, model/content-policy, cross-domain join or
seven-party acceptance. Those remain separate steps of the same real product
deploy. Keep `runtimeStarted`, `nativeHistoryRecoveryAccepted` and
`authenticatedReady` false in this receipt.

Before stopping an existing controller without `MOSS_INSTANCE_ID`, inspect its
registered identity using the same producer bundle:

```sh
node /pinned/bin/moss-qualify-sqlite-upgrade.mjs --inspect-controller /absolute/moss.db "$verified_service_pid" "$configured_heartbeat_timeout_ms"
```

The deployment adapter must obtain the PID from the owned service and the timeout
from its existing Moss recovery configuration (30,000 ms when absent). This is
a read-only observation of exactly one fresh `server_instances` row, matched to
that PID. It refuses another live controller, stale rows or a future heartbeat.
Persist the returned operational identity in the deployment's private config
for its next controlled stop/start; never edit heartbeat/status rows to evade
fencing. It does not establish Agent identity or authentication. The configured
`/readyz.instance_id` may remain null until that migration and must not be
confused with the registered runtime identity. Stop the old owner before starting
its replacement, then require actual HTTP readiness as well as process ownership.

The same bundle's `--prepare-controller-config CONFIG DB PID CONFIG_SHA256 OUTPUT`
uses that observation and the native config schema to prepare a private new
configuration. It preserves all original fields, changing only
`server.instanceId`, refuses a conflicting configured/environment ID, and never
overwrites either the source or an existing output. The product adapter owns
exclusive configuration installation, service stop/start and readiness checks.

The producer also builds a separate `moss-inspect-existing-product.mjs`. Given
an absolute existing config and a new evidence directory, it authenticates
once to that config's loopback Moss port using its explicitly configured
Moss credential, reads existing session metadata and a persisted UI context,
and logs out its own token. It does not change accounts, model selection,
Agents or sessions, nor submit a turn. Only context hashes/counts enter the
receipt. UI history readability is distinct from native engine resume.

The explicit `CONFIG EVIDENCE --resume-existing SESSION_ID` mode instead
resumes that already-visible, same-owner cohost session through the normal
Moss API. It requires the original locator, verifies the native repository's
stored owner/Agent/durable-SID/repository binding and unchanged projected
messages, and sends no model turn. It leaves the resumed execution with Moss;
the enclosing private-copy fixture owns cleanup. This mode is a real state
change and must not be used as a read-only probe. A successful native resume
still does not prove a dependent real-model turn used the recovered history.
