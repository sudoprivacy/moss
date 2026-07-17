# corpapp — Corp App (企业应用) CLI

A small, zero-dependency Go binary that scode runs inside the moss
runtime container to talk to enterprise apps (e.g. 企微自建应用 / WeCom
self-built apps) registered under **企业应用管理 (Corp App Management)**.

It is the corp-app analogue of the `wiki` CLI: it authenticates with the
`SESSION_TOKEN` JWT that moss-server issues for the scode session and
calls the agent-facing API at `/api/v1/agent/corp-apps/*`. The assistant
can only use the corp-app instances granted to it via `enabledCorpApps`
in its `_moss_meta.json` (enforced server-side on every call).

## Usage

```
corpapp list [--json]                                       # apps this assistant can use
corpapp get --name <name> [--json]                          # resolve an app by name
corpapp get --key <corpId:agentId> [--type wecomapp] [--json]
corpapp send --app <name> --to <userid> --text <msg>        # send a text message
corpapp send-file --app <name> --to <userid> --file <path>  # upload + send a file
corpapp receive --app <name> [--since <cursor>] [--limit <n>] [--json]   # poll inbound
corpapp download --app <name> --media-id <id> [--out <path>]             # fetch media bytes
corpapp approvals --app <name> --start <ts> --end <ts> [filters]         # list 审批单号
corpapp approval --app <name> --sp-no <spNo> [--attachments] [--json]    # one approval's detail
```

`receive` returns a `nextCursor`; pass it back as `--since` on the next
poll to read only newer messages. Inbound file/image messages carry a
`mediaId` and `fileName` (not the bytes); fetch the bytes with
`download`:

```
# typical receive → download flow
corpapp receive  --app SeanClaw --since 0 --json
corpapp download --app SeanClaw --media-id <mediaId from above> --out /tmp/
```

For `download`, `--out` may be a file path, or a directory (the
server-provided filename is used inside it); if omitted, the file is
written to the current directory under that filename.

## Approvals (企微审批流)

For WeCom self-built apps, `approvals`/`approval` read OA approval flows.
Requires the app to be added under **审批 → 「可调用接口的应用」** in the
WeCom admin console, its **企业可信IP** to include the server's egress IP,
and the corp app to declare the `listApprovals`/`getApproval` capabilities
(shown by `list`).

`approvals` lists the approval ids (`sp_no`) in a time window (WeCom caps
the window at 31 days). `--start`/`--end` are Unix seconds.

```
# list approvals, filtered by type and status
corpapp approvals --app SeanClaw --start 1781672229 --end 1784264229 \
  --status 2 --template 3WNgn7Vr9JWxiUVRHZeekdd8YjYDQRdVj845n1Ky
```

Filter flags:

- `--status <n>` — approval status (`sp_status`):
  `1`=审批中 `2`=已通过 `3`=已驳回 `4`=已撤销 `6`=通过后撤销 `7`=已删除 `10`=已支付
  (validated client-side).
- `--template <id>` — approval type (`template_id`).
- `--filter key:value` — any other WeCom filter (`creator`, `department`,
  `record_type`); repeatable. Different keys AND together.
- `--cursor <c>` / `--size <n>` — pagination.

`approval --sp-no <spNo>` returns the raw WeCom detail (type, status,
applicant, `sp_record` approver steps with outcome/comment/time, comments,
and `apply_data` form fields).

### Attachments

Approval attachments live in three places WeCom nests separately. Add
`--attachments` to flatten them into one list (id / source / label) ready
to feed into `download`:

```
corpapp approval --app SeanClaw --sp-no 202607170002 --attachments
# KIND       SOURCE    ID                                    LABEL
# file_id    form      WWME_...                              附件
# media_id   comment   WWME_...                              哦哦
corpapp download --app SeanClaw --media-id WWME_... --out ./
```

`--attachments` covers form File controls (including nested Table/子表单
rows), comment attachments, and approver-step attachments. Both `file_id`
and `media_id` handles download through the same `download` command.

## Capabilities

Capabilities are per-type and reported by the server (`list`/`get` show
them). Calling a capability a type does not support returns a clear
error (HTTP 501 surfaced as a CLI error).

## Environment (set by moss-server when it spawns scode)

- `MOSS_SERVER_URL` — base URL of moss-server
- `SESSION_TOKEN` — bearer JWT carrying `assistant_id` / `user_id` / `org_id`

## Build

```
cd cli/corpapp
go build -o corpapp .
```

The runtime image builds and installs it to `/usr/local/bin/corpapp`
(see `deploy/runtime/Dockerfile`).
