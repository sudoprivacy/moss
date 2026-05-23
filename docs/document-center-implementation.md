# Document Center — P0 Implementation

> Implementation status as of `feat/document-center` branch
> Pairs with the design doc at
> `/Volumes/wpd/cowork/sudowork/docs/plans/文档中心-Document-Center-P0设计.md`

## What's in this branch

Everything needed for the P0 happy path:

- DB schema for document tree, documents, wikis, build jobs
- DocumentStore high-level API + REST routes (admin + agent surfaces)
- AdminHub UI: tree with expand/collapse, doc uploads, Wiki list, Assistant ↔ Wiki tab
- WikiJobExecutor polling worker that drives builds through RuntimeService
- `wiki` Go CLI baked into the scode runtime Docker image
- INDEX injection into first-message system prompt
- JWT helper + per-assistant ACL on agent-facing wiki endpoints
- SSE-based build progress streaming + UI subscription

Commits on `feat/document-center` (chronological):

| Commit  | Slice            |
| ------- | ---------------- |
| ad6a28c | DB + DocumentStore foundation |
| 906fd08 | REST routes (admin + agent) |
| 96b170c | AdminHub page + tree component |
| 8ba6cd3 | Assistant ↔ Wiki association |
| 08448cf | WikiJobExecutor (real build worker) |
| 4f38cd5 | Go wikiCli + multi-stage Dockerfile |
| 30739f2 | INDEX injection + JWT + ACL |
| `HEAD`  | SSE progress + README (this commit) |

## What runs end-to-end today

1. `bun run build` (or whatever the moss bundle command is) — picks up
   the new TS / Go files. Server starts as usual on `:43127`.
2. AdminHub:  `/document-center` route appears in the sidebar.
3. Tree CRUD, doc upload, Wiki create — all hit the new `/api/v1/documents/*`
   and `/api/v1/wikis/*` endpoints.
4. Click "Build" — `WikiJobExecutor` picks up the queued job within 3 s,
   creates a Moss runtime session with `assistantName: 'wiki-builder'`
   and `cwd = $MOSS_HOME/wikis/<wikiId>`, feeds it the hardcoded wiki
   build prompt, and waits for `type=result`. SSE pushes
   `wiki_build_status` updates to the AdminHub UI in real time.
5. Assistant edit dialog (`/settings/agents → 编辑`) shows a "关联 Wiki"
   section right under "关联技能". Selected wiki IDs are persisted to the
   assistant's `_moss_meta.json` as `enabledWikis: string[]`.
6. The `wiki` CLI (built into the runtime container at
   `/usr/local/bin/wiki`) talks to `/api/v1/agent/wikis/*` using the
   SESSION_TOKEN env var set by moss-server.

## What's intentionally left for next iteration

These are wired in code but not yet "full power":

- **SESSION_TOKEN injection from moss-server**:  `issueWikiSessionToken`
  helper exists in `src/server/auth/token.ts`, but RuntimeService /
  WikiJobExecutor don't yet sign tokens automatically. For dev, set
  SESSION_TOKEN manually in the moss-server shell. Production wiring
  will pass it through `BackendSpawnOptions` → `buildSessionEnv`
  overrides.
- **Document parsing for build worker**:  `WikiJobExecutor.prepareInputs`
  currently raw-copies docx/pdf into `<cwd>/input/`. Proper conversion
  pipeline (mammoth for .docx, libreoffice for .pdf) is the next item.
  The agent's own `read_file` tool can handle binary fallback for now.
- **`wiki-builder` system assistant on disk**:  the build prompt is
  hardcoded in `WikiJobExecutor.WIKI_BUILDER_PROMPT`. Promote it to
  `$MOSS_HOME/assistants/system/wiki-builder/system.md` once tuned.
- **Wiki INDEX auto-injection in real chat sessions**:  the
  `prepareFirstMessageForScode` function accepts `availableWikis` now,
  but the caller in `runtimeService.ts` / `sessionRunnerDaemon.ts`
  doesn't yet populate it from `assistant.enabledWikis`. Drop-in
  follow-up: load enabled wikis + their public meta and pass through.

## Quick smoke test (without a real LLM)

The build worker will fail gracefully when scode isn't reachable.
For UI / DB smoke:

```bash
# Server starts, you can hit:
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:43127/api/v1/documents/tree
# → { "nodes": [] }

# Create a node
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"parent_id":null,"name":"返厂业务"}' \
     http://localhost:43127/api/v1/documents/tree/nodes
# → DocumentTreeNode JSON

# Verify Wiki agent endpoints reject unauthorised callers
curl -H "Authorization: Bearer $LOW_PRIV_TOKEN" \
     http://localhost:43127/api/v1/agent/wikis
# → 403 forbidden
```

For SSE:

```bash
curl -N -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:43127/api/v1/wikis/<wikiId>/build-events
# Prints `event: progress\ndata: {...}\n\n` lines as the build runs.
```

## File map

```
src/server/
  ├── db.ts                              (+ 4 tables + query methods)
  ├── documentStore.ts                   NEW high-level CRUD
  ├── server.ts                          (+ ~500 lines of routes)
  ├── auth/token.ts                      (+ issueWikiSessionToken, assistantId)
  ├── backends/backendUtils.ts           (+ MOSS_SERVER_URL injection)
  └── agentStore.ts                      (+ enabledWikis in AssistantStoreMeta)

src/channels/gateway/
  └── WikiJobExecutor.ts                 NEW build worker

src/utils/
  ├── wikis/localWikiDirectories.ts      NEW $MOSS_HOME/wikis path helpers
  └── scodeBridge.ts                     (+ availableWikis INDEX injection)

cli/wiki/                                NEW Go CLI
  ├── main.go
  ├── go.mod
  └── README.md

deploy/runtime/Dockerfile                (+ multi-stage build for wiki CLI)

admin/
  ├── lib/api/document-center.ts         NEW API client + SSE helper
  ├── src/pages/document-center-page.tsx NEW
  ├── src/app.tsx                        (+ /document-center route)
  ├── components/app-sidebar.tsx         (+ 文档中心 nav item)
  ├── src/pages/agent-hub-page.tsx       (+ Wiki association section)
  └── lib/api/agent-hub.ts               (+ enabledWikis in types)
```

## Total diff

~4000 lines across 8 commits. Roughly 60% Server / DB, 30% AdminHub UI, 10% Go CLI + Dockerfile.
