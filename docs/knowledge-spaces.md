# 知识库空间：租户 / 私有，及无智能体直接使用

Wikis follow the same ownership model as agents and skills.

| | 租户（tenant）— 文档中心 | 私有（private）— SudoWork |
|---|---|---|
| Like | 专属 agent/skill | custom agent/skill |
| Managed in | admin UI (`/api/v1/documents/*`, `/api/v1/wikis*`) | SudoWork (`/api/v1/me/*`) |
| Who edits / rebuilds / sets scope | holders of `admin:documents` whose management scope covers the owner (`isCreatorInScope`). Legacy rows are owned by `admin`, so only full admins can manage them | the owner only, admins included |
| Admins on others' items | full control | see, disable, delete — never edit or rebuild |
| 可用范围 (scope) | everyone / departments / users / only me / 仅管理员 | everyone / departments / users / only me (default) |
| Legacy rows (before this change) | owner `admin`, scope 仅管理员 | — |

Source code: `src/server/wikiAccess.ts` (rules) and `src/server/documentStore.ts` (storage and space checks).

## Using wikis

- **Without an agent:** a session may use any wiki whose scope includes its user; disabled wikis never count.
  - Admins may use every tenant wiki. They may use a private wiki only when its owner's scope includes them.
  - The `wiki` CLI (`/api/v1/agent/wikis*`) serves these wikis.
  - The `[Available Wikis]` prompt block lists the wikis the client picked: `enabled_wikis` on `POST /api/v1/sessions`, chosen from `GET /api/v1/wikis/usable`.
- **Through an agent:** binding a wiki to an agent (`enabledWikis`) is always allowed, as long as the editor can see the wiki. The agent's reach can be wider than the wiki's scope. Whether users outside the wiki's scope still get it depends on who controls the binding (`agentDelegationPolicy`):

  | Agent | Tenant wiki, user outside its scope | Private wiki |
  |---|---|---|
  | hub / system (only admins edit) | delivered: the agent is the grant | not delivered |
  | custom or 专属 agent authored by a full admin (the admin UI's 创建智能体 stores agents as custom) | delivered | not delivered |
  | 专属 agent authored by anyone else | delivered only if the wiki's scope already covers the agent's | not delivered |
  | custom agent authored by anyone else (a user's own) | not delivered | not delivered |

  The author counts by their current role.

  Consequences:
  - A user can never re-share, through an agent they scope themselves, a wiki they were only given.
  - Existing admin-managed agents over admin-only legacy wikis keep working.
  - Uploaded agent packages cannot carry `enabledWikis` / `enabledCorpApps` / `enableCorpAuth`.

  The agent editors warn about every case (`POST /api/v1/wikis/scope-check` returns `covered` and `delegated`).
- **Knowledge spaces never mix:** a tenant wiki cannot read private folders or documents, and a private wiki reads only its owner's space. Folders cannot move between spaces.

## SudoWork client API (private space)

All routes take a Bearer token, are open to any active user, and are scoped to the caller.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/me/documents/tree` | Creates the 私有 root on first call. Returns `{ root_id, nodes, usage_bytes, quota_bytes }` |
| POST | `/api/v1/me/documents/nodes` | Body `{ parent_id?, name, description? }`; `parent_id` defaults to the root |
| PATCH / DELETE | `/api/v1/me/documents/nodes/:id` | Rename, move within the space, or delete. The root is fixed |
| GET | `/api/v1/me/documents/nodes/:id/documents[?recursive=1]` | |
| POST | `/api/v1/me/documents/nodes/:id/documents` | Body `{ file_name, mime_type?, content_base64 }`; 50MB per file |
| POST | `/api/v1/me/documents/nodes/:id/folder` | Body `{ folder_name?, on_conflict?: 'replace' \| 'skip', files: [{ relative_path, mime_type?, content_base64 }] }`. Details below |
| DELETE | `/api/v1/me/documents/:docId` | |
| GET / POST | `/api/v1/me/wikis` | Create body: `{ name, description?, source_mode: 'dir' \| 'files', source_node_ids \| source_document_ids, source_exclude_node_ids?, visible_to?, build?: true }` |
| GET / PATCH / DELETE | `/api/v1/me/wikis/:id` | PATCH also accepts `visible_to` and `enabled` |
| PATCH | `/api/v1/me/wikis/:id/enabled` | Body `{ enabled }` |
| POST | `/api/v1/me/wikis/:id/build` | 409 while another of the user's private builds is queued or running |
| GET | `/api/v1/me/wikis/:id/build-status`, `/build-jobs`, `/build-events` | `build-events` is SSE and also accepts `?token=` |
| POST | `/api/v1/me/wiki-build-jobs/:id/cancel` | |
| GET | `/api/v1/wikis/usable` | Every wiki the caller may use, tenant and private. Use it to pick `enabled_wikis` |
| GET | `/api/v1/directory` | Departments and users for the scope picker |

How folder upload works:
- It mirrors a local folder under `folder_name`, creating subfolders from each `relative_path`.
- Same-named files are replaced by default.
- The request body is capped at 200MB.

Scope values (`visible_to`):
- `null`: everyone
- `{ department_ids: [...] }`: those departments, including sub-departments
- `{ user_ids: [...] }`: those users
- `{ user_ids: [me] }`: only me

The owner is always included.

Quota: each user's private space is capped by `wikiIndex.privateSpaceQuotaMb`, default 1024. The environment variable `MOSS_PRIVATE_SPACE_QUOTA_MB` overrides it. Exceeding the cap returns 413.
