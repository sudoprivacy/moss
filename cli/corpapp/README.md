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
corpapp send --app <name> --to <userid> --text <msg> [--format text|markdown]  # send a message
corpapp send-file --app <name> --to <userid> --file <path>  # upload + send a file
corpapp receive --app <name> [--since <cursor>] [--limit <n>] [--json]   # poll inbound
corpapp download --app <name> --media-id <id> [--out <path>]             # fetch media bytes
corpapp approvals --app <name> --start <ts> --end <ts> [filters]         # list 审批单号
corpapp approval --app <name> --sp-no <spNo> [--attachments] [--json]    # one approval's detail

corpapp groups --app <name> [--owner <userid,...>] [--cursor <c>] [--limit <n>]  # list 客户群
corpapp group --app <name> --chat-id <id> [--no-name]                    # one group + members
corpapp send-group --app <name> --sender <userid> --chat-id <id> ...     # create a 群发 task
corpapp group-msgs --app <name> --start <ts> --end <ts> [--creator <u>]  # past 群发 tasks
corpapp group-msg-summary --app <name> --msgid <id> --userid <u> [--json]  # what actually landed
corpapp group-msg-result --app <name> --msgid <id> --userid <u>          # raw per-target status
corpapp group-msg-task --app <name> --msgid <id>                         # raw per-member status
corpapp group-msg-remind --app <name> --msgid <id>                       # nudge the sender
```

### Colored / styled messages

`--format text` (the default) sends plain text with no styling. Pass
`--format markdown` to enable styling.

WeCom supports exactly **three** colors, via `<font color="...">`:

| tag | renders |
| --- | --- |
| `<font color="info">` | green |
| `<font color="comment">` | gray |
| `<font color="warning">` | orange |

**WeCom has no red.** Map any "red"/urgent request to `warning` (orange) —
an unsupported color name is rendered as plain unstyled text.

```
corpapp send --app myapp --to zhangsan --format markdown \
  --text '<font color="info">通过</font> <font color="warning">2 项告警</font>'
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

## Customer groups (客户群) and 群发

For WeCom self-built apps, `groups`/`group` read customer groups and
`send-group` broadcasts to them. Requires the app to be added under
**客户与上下游 → 客户联系 → 「可调用接口的应用」** in the WeCom admin console
(a *different* list from 审批), and the corp app to declare the
`listCustomerGroups` / `sendGroupMsg` capabilities.

### Reading groups

```
corpapp groups --app SeanClaw --owner linqinhui
corpapp group  --app SeanClaw --chat-id wr_xxx
```

`group` returns the raw WeCom detail — name, owner, notice, admin list and
`member_list`, where each member has:

| field | meaning |
| --- | --- |
| `type: 1` | internal staff — a real `userid` you can use as `--sender` |
| `type: 2` | external contact — an opaque `external_userid` (`wo_...`) |
| `name` | display name; returned by default, suppressed by `--no-name` |
| `group_nickname` | in-group nickname (often empty) |

**Visibility is decided by the GROUP OWNER, not by membership.** A group
whose 群主 is outside the app's visible range is *silently absent* from
`groups` — no error, just a shorter list. Two consequences:

- Compare the returned count against the real number of customer groups
  before trusting a sync. A short list looks identical to a complete one.
- Without `--owner`, WeCom walks every owner in range and fails with
  `81017` once that exceeds 1000 people. At scale, page with `--owner`
  (max 100 userids per call).

### Sending

```
corpapp send-group --app SeanClaw --sender linqinhui \
  --chat-id wr_xxx --text '本周报表' --file ./report.pdf
```

`--chat-id`, `--file` and `--media-id` are repeatable. Files are uploaded
first and attached by media id (max 9 attachments; text max 4000 bytes).

**`send-group` does not send.** It creates a task that a human must confirm
in 企微 群发助手. Tasks created through *any* API call are recorded by WeCom
as `create_type=0` (企业发表) with an empty `creator`, which additionally
requires an **administrator to approve** them before the sender is even
notified. Only messages composed by a person inside the WeCom client are
`create_type=1` (个人发表) and skip that step — no request parameter or
credential changes this, so budget for two human actions per task.

`--sender` must be an internal staff userid **already in the target group**
(an `external_userid` is rejected with `60111`). Omitting the flag makes
WeCom auto-assign to the group owner; passing an empty string fails with
`40058`.

### The daily cap

**Each customer group accepts one broadcast per day**, and going over it
fails in the worst possible way — silently, after a human has done work:

1. `send-group` returns `errcode 0` with a valid msgid
2. an admin approves it
3. the sender taps confirm, and `group-msg-task` reports `已发送`
4. the group receives **nothing** (send result status `3`)

So `send-group` checks before creating anything:

| flag | effect |
| --- | --- |
| `--cap-window calendar` | default; quota resets at provider midnight, evaluated in `Asia/Shanghai` — the provider's clock, not yours |
| `--cap-window rolling24h` | stricter: a 23:50 send still blocks 00:10 next morning |
| `--skip-capped` | drop over-quota targets, send to the rest |
| `--no-cap-check` | skip the check (WeCom will still drop them) |

Which boundary WeCom actually uses is **not documented**; `calendar`
matches its wording, `rolling24h` is safer if you schedule near midnight.

The check blocks a group for either of two reasons:

| reason | meaning |
| --- | --- |
| **already received** | a broadcast reached it inside the window (send result status 1) — the quota is spent |
| **awaiting confirmation** | an unconfirmed task targets it — the quota is not spent *yet*, but confirming that task will spend it |

The second reason matters because **quota is consumed at confirmation, not at
creation**, and a human may confirm hours later. Observed in production: a task
created at 08:10 passed a delivered-only check, because the task that beat it
was not confirmed until 10:18 — then settled as status 3, wasting a
confirmation. Pending tasks are therefore blocked regardless of age: one created
just before midnight consumes the *next* day's slot when confirmed.

`--skip-capped` drops targets blocked for either reason. For a pending block,
cancelling the outstanding task frees the slot immediately.

Two limits worth knowing before relying on the guard:

- **Quota is shared across senders.** A colleague broadcasting to the same
  group consumes it, and this check only sees tasks visible to `--sender`.
  Observed in production: one task delivered to some groups and hit status
  3 on others, because other teams had already broadcast that morning.
- It is a **pre-check, not a lock** — concurrent campaigns can both pass.

Durable per-group state belongs in the calling skill. Treat this as a
guard against the common sequential case, not a guarantee.

### Reconciling what actually landed

Never treat `group-msg-task` as proof of delivery — per member, it only
reports that the human tapped send. Use `group-msg-summary`, which follows
the cursor and classifies every target:

```
corpapp group-msg-summary --app SeanClaw --msgid msg_xxx --userid linqinhui
# msgid msg_xxx
# delivered=1  pending=0  failed=1
#
# WARNING: 1 target(s) received nothing — already got a broadcast today.
# Each group accepts one broadcast per day; retry tomorrow.
```

Status codes: `0` 未发送 · `1` 已发送 · `2` 客户不是好友 · `3` 今日已收到其他群发.

If a task sits unconfirmed, `group-msg-remind` re-triggers the sender's
prompt (WeCom allows 3 reminders per task per 24h; the API does not report
how many remain, so track your own count).

### No @-mentions

`text` is **plain text only** — no markdown, no HTML, and no way to @ a
member or customer. The `mentioned_list` parameter people find in WeCom
docs belongs to 群机器人 webhooks (which cannot join external groups), and
`<@userid>` applies to app-created internal groups. Writing `@张三` in the
text renders as literal characters with no notification.

To actually notify someone, send them a 1:1 message with `corpapp send
--to <userid>` — that does push. A common shape is: broadcast the content
to the group, then ping the responsible internal colleague directly.

## 消息队列（group-msg-queue）

发送配额是**在人工确认时**扣掉的，不是创建任务时 —— 而确认可能发生在数小时之后。
因此「这个群今天发过了吗」无法只靠「已送达记录」回答：一条还在等确认的任务同样
占着当天名额。队列就是用来记住这个「意图」的，**按 corp app 分目录、按群分文件、
跨会话持久**。

### 标准循环（顺序有意义）

```bash
APP=数牍

# 1. 超时回收 —— 按每条自己的 --expires-at
corpapp group-msg-queue --app $APP --action reap --cancel-wecom

# 2. 业务撤销 —— 调用方查业务数据后自行决定
corpapp group-msg-queue --app $APP --action list --state pending --json
corpapp group-msg-queue --app $APP --action cancel --chat-id wr_xxx \
  --entry-id q_... --reason "排期已取消" --cancel-wecom

# 3. 结算已发送的
corpapp group-msg-queue --app $APP --action reconcile

# 4. 入队（只存元数据，不存内容）
corpapp group-msg-queue --app $APP --action enqueue --chat-id wr_xxx \
  --meta '{"type":"日常追货提醒","customer_id":"C1024"}' \
  --idempotency-key '日常追货提醒:C1024:2026-08-27' \
  --expires-at 2026-08-26T10:00:00+08:00

# 5. 问「现在哪些群能发」
corpapp group-msg-queue --app $APP --action next

# 6. 逐条：占位 → 组装 → 发送 → 标记
corpapp group-msg-queue --app $APP --action claim --chat-id wr_xxx --entry-id q_...
corpapp send-group --app $APP --sender linqinhui --chat-id wr_xxx --text "..." --file ./x.xlsx
corpapp group-msg-queue --app $APP --action mark-sent --chat-id wr_xxx \
  --entry-id q_... --msgid msg_... --sender linqinhui
# 发送失败则归还名额，否则名额空烧一天：
corpapp group-msg-queue --app $APP --action release --chat-id wr_xxx \
  --entry-id q_... --reason "send-group 失败"
```

**前三步必须跑在 `next` 之前** —— 它们都会释放名额。放到后面，被占住的名额当天不会
释放，那个群就白白锁死一天。

### 两种撤销，刻意分开

| | 依据 | 谁判断 |
|---|---|---|
| `reap` | 只看每条自己的 `--expires-at` 是否已过 | moss，**从不读 `--meta`** |
| `cancel` | 「排期已取消」「客户已回复」等业务条件 | 调用方，需查业务数据 |

过期时刻在入队时按业务算好，**按小时或按天都能表达**（`--expires-at` 是绝对时间戳）。
不传则默认 **入队时间 +72 小时** —— 这只是兜底，防止漏传的条目永久占住该群名额
（`next` 会一直以 `pending_exists` 跳过它且不报错）；对时效有要求就显式传。

不同消息类型、不同客户都可以不同。moss 侧不增加任何业务规则参数。

### 为什么 claim 要独立于 mark-sent

组装内容可能耗时数十秒（查数、生成 xlsx）。不先占住名额，另一个 agent 可能在这段
时间里也通过 `next` 拿到同一个群 —— 两边都发，输的那条在人工确认之后才以 status 3
死掉，白白浪费一次确认。

### 三条约定

- **`next` 绝不静默截断**：`totalEligible` / `hasMore` 恒返回，被挡下的群都在
  `skipped` 里带原因。`--limit` 是**主动限流**（每条都要一次管理员审批 + 一次发送人
  确认），不是安全阀。
- **`skipped` 必须如实回报**：客户今天没收到消息，运维要知道是「已发过」还是
  「上一条还在等确认」。
- **status 3 不自动重排**：置 `failed` + 释放名额，是否还值得发是业务判断
  （排期已过的提醒不该重发）。用 `list --state failed` 自行决定。

### 状态机

```
pending ──claim──> claimed ──mark-sent──> sent ──reconcile──> delivered  (status 1)
   │                  │                     │              └─> failed   (status 2/3)
   │                  └──release──> pending └─ (status 0 保持 sent)
   └──cancel / reap──> cancelled
```

存储位置：`$MOSS_HOME/wecom-queue/<corpAppId>/<chat_id>.json`，原子写入
（tmp + rename），按 corp app 串行化。

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
