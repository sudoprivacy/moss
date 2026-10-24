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

Bundle the checker and its exact dependencies for an offline target rather
than installing a compiler or a new production service there. Bind the receipt
to the source and generated bundle hashes. Dependency/source equivalence must
be established before using an older producer artifact's migration result.

A pass is not a service drain, native cohost-data migration, history recovery,
runtime rollback, owner credential, model/content-policy, cross-domain join or
seven-party acceptance. Those remain separate steps of the same real product
deploy. Keep `runtimeStarted`, `nativeHistoryRecoveryAccepted` and
`authenticatedReady` false in this receipt.
