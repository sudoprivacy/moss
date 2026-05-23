# wiki — Document Center CLI

`wiki` is a small Go CLI that the scode agent uses inside the moss
runtime container to query the Document Center's knowledge bases.

## Build

```bash
cd cli/wiki
go build -o wiki .
```

Produces a single static binary (~8 MB). No external dependencies.

For the runtime container we build it with `CGO_ENABLED=0` so the
resulting binary works on the slim Ubuntu image used by `deploy/runtime/`.

## Usage

The CLI is **not** intended to be invoked directly by humans. moss-server
sets two env vars when it spawns a session; the CLI refuses to run
without them:

| Env var           | Purpose                                                   |
| ----------------- | --------------------------------------------------------- |
| `MOSS_SERVER_URL` | Base URL of moss-server (e.g. `http://moss:43127`)        |
| `SESSION_TOKEN`   | Bearer JWT with `assistant_id` / `user_id` / `org_id`     |

### Subcommands

```bash
wiki list                                   # list wikis visible to this assistant
wiki list --json                            # JSON output (for chaining)

wiki read <wikiId>                          # print WIKI.md
wiki read <wikiId> --file <path>            # print a specific chunk
wiki read <wikiId> --list                   # list files in the wiki

wiki search <wikiId> <query>                # full-text grep, returns "file:line: text"

wiki metadata <wikiId>                      # build time / doc count / chunk count
```

### Sample LLM-facing output

```text
$ wiki list
ID                                    NAME                            DESCRIPTION
abc12345-...-...                      返厂业务 Wiki                   涵盖返厂申请、物流追踪、售后异常处理流程
def67890-...-...                      财务对账 Wiki                   月度对账规则、汇率换算、海关单匹配

$ wiki search abc12345 物流单号
chunk-002-logistics.md:15: 物流单号由仓库录入,格式为 LOG-YYYYMMDD-NNNN...
chunk-002-logistics.md:42: 物流单号必须满足以下校验规则:...
```

## Server endpoints used

All requests carry `Authorization: Bearer ${SESSION_TOKEN}`.

| CLI subcommand | Endpoint                                          |
| -------------- | ------------------------------------------------- |
| `list`         | `GET /api/v1/agent/wikis`                         |
| `read`         | `GET /api/v1/agent/wikis/:id/files/:path`         |
| `read --list`  | `GET /api/v1/agent/wikis/:id/files`                |
| `search`       | `GET /api/v1/agent/wikis/:id/search?q=...`        |
| `metadata`     | `GET /api/v1/agent/wikis/:id/metadata`            |

Server-side scope check (currently `admin:documents`) will be replaced
in D6 by SESSION_TOKEN-based assistant filtering, so each assistant only
sees the wikis it has been authorised for (via the assistant meta
`enabledWikis: string[]` field).
