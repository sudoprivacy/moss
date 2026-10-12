# Task Plan: Member Key `needs_review` Recovery Implementation

## Goal
Implement safe remote reconciliation and adoption of uncertain member/service Keys, verify all checks, then commit, push, and open a PR to `dev`.

## Phases

### Phase 1: Isolated baseline
- [x] Fetch latest `origin/dev`
- [x] Create `codex/member-key-needs-review-recovery` worktree
- [x] Re-check current service, adapter, schema, route, UI, and tests

### Phase 2: Persistence and adapter contract
- [x] Add provisioning-attempt and review-audit tables
- [x] Add internal-only recoverable-token inspection without weakening public masking

### Phase 3: Recovery state machine
- [x] Add replay-safe member/service reconciliation and secret verification
- [x] Fence `needs_review` from normal provisioning
- [x] Persist outcomes and audit evidence transactionally

### Phase 4: API and admin UI
- [x] Add provisioning/reconcile endpoints and typed client methods
- [x] Replace the misleading provision action with “核对远端 Key” for review state
- [x] Keep raw Keys out of all public payloads and UI state

### Phase 5: Targeted tests
- [x] Cover lost response, no duplicate POST, vault resume, unsafe candidates, authorization, concurrency, and member/service flows
- [x] Cover UI action selection and secret non-exposure

### Phase 6: Full verification
- [x] Run root tests, typecheck, lint, and Node build
- [x] Run admin check, targeted UI test, and build
- [x] Review diff and scan for secrets

### Phase 7: Delivery
- [ ] Commit only after all checks pass
- [ ] Push branch and create PR targeting `dev`

## Current Phase
Phase 7
