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

corpapp names --app <name> --users <id,...> [--room <roomid>]             # ids -> names
corpapp names --app <name> --rooms <roomid,...>                          # roomids -> group names

corpapp groups --app <name> [--owner <userid,...>] [--cursor <c>] [--limit <n>]  # list 客户群
corpapp group --app <name> --chat-id <id> [--no-name]                    # one group + members
corpapp send-group --app <name> --sender <userid> --chat-id <id> ... [--json]  # create a 群发 task
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
| `--cap-lookback 72h` | how far back to look for **tasks** (default `72h`, range `24h`–`744h`); see below |
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
confirmation. Pending tasks therefore block however old they are (within
`--cap-lookback`): one created just before midnight consumes the *next* day's
slot when confirmed.

`--skip-capped` drops targets blocked for either reason. For a pending block,
cancelling the outstanding task frees the slot immediately.

**`--cap-lookback` is not the quota window.** WeCom lists 群发 tasks by
*creation* time, but a task spends the quota of the day it is *confirmed*. So
the check has to look at tasks created before today too: one created yesterday
evening and confirmed this morning has already used today's slot, and one
created yesterday that is still waiting will use whichever day it is confirmed
on. Until this flag existed the check listed only tasks created since today
00:00 and missed both. Example (2026-10-15 → 16):

> 10月15日 18:04 给群 wr_A 建了群发 msg_1，当天没人审批。10月16日 09:30 再给 wr_A
> 发，旧检查只看「今天 0 点后创建」的任务，看不到 msg_1，放行建了 msg_2。管理员
> 先批了 msg_1 → 群里收到周四的旧内容、今天名额被它用掉；msg_2 确认后 status 3，
> 什么都没收到。

The default `72h` covers the queue's default entry TTL — after it, `reap
--cancel-wecom` withdraws unconfirmed tasks, so older ones should not exist.
Widen it if tasks are also created outside the queue, or a withdrawal may have
failed. The provider caps the listing at one month.

Cost: each task created before today costs one extra `get_groupmsg_task` call;
its send result is only read if someone has not confirmed yet or confirmed
today. Tasks created today are checked exactly as before.

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

### Errors worth telling apart

| errcode | Meaning | What to do |
|---|---|---|
| `45009` | Rate limited | Transient. moss-server already retries twice (1s, 3s) before surfacing it; if it still reaches you, release the entry and let a later round retry. Never cancel on it. |
| `41048` | `no customer to send` — WeCom found no recipient for this sender in that group | Not transient: retrying the same sender/group will not help. Check that the 发送人 is actually in that group before re-queuing. |
| daily cap | `send-group` refused: the group already received, or has a pending, 群发 | Expected on a second same-day send. Not a failure of the message. |

The access_token behind every call is cached process-wide in moss-server, so
issuing many `corpapp` calls in a row no longer costs a `gettoken` each. Still
send serially: the provider's per-app rate limits are not documented, and a
burst of parallel `send-group` calls is the easiest way to meet them.

### No @-mentions

`text` is **plain text only** — no markdown, no HTML, and no way to @ a
member or customer. The `mentioned_list` parameter people find in WeCom
docs belongs to 群机器人 webhooks (which cannot join external groups), and
`<@userid>` applies to app-created internal groups. Writing `@张三` in the
text renders as literal characters with no notification.

To actually notify someone, send them a 1:1 message with `corpapp send
--to <userid>` — that does push. A common shape is: broadcast the content
to the group, then ping the responsible internal colleague directly.

## 内部群（内部群 / appchat）

内部群和客户群是**两种不同的产品**，差别决定了用法：

| | 客户群（外部） | 内部群 |
|---|---|---|
| 每日限额 | 每群每天 1 条 | **无** |
| 人工环节 | 管理员审批 + 发送人确认 | **无，调用即送达** |
| 显示的发送者 | `--sender` 指定的内部成员 | **恒为应用本身** |
| 能否枚举 | `groups` / `group` | **不能**，无 list/search 接口 |

**所以内部群不需要队列** —— 没有名额要抢、没有回执要对账、没有超时要回收，组装好直接发。

### 两条硬约束（均已对线上租户实测）

1. **应用可见范围必须是「根部门」**。逐个添加成员**不够** —— 实测加到 2 人仍然
   `48002`，改成根部门后同一个调用立刻成功。

2. **只能发给本应用创建的群**，而企微**没有任何枚举内部群的接口**。所以 chatid
   只能来自 `create-internal-group` —— 别人在企微客户端手建的群，既发不了、也拿
   不到它的 chatid。**建群返回的 chatid 一定要记下来。**

没有 `--sender` 参数，这不是遗漏：企微对 `sender`/`from`/`userid`/`fromuser`/
`owner` 一律返回 `40058`，连群主本人也不行。要让消息「看起来是某人发的」，只能把
名字写进正文。

### @提醒：内部群**可用**，但只认参数不认正文

这和客户群相反 —— 客户群的 `@名字` 只是字面文本，内部群能触发**真实提醒**。
线上实测：

| 写法 | 效果 |
|---|---|
| `--mention zhuyx` | ✅ 收到「[you were mentioned]」 |
| `--mention-all` | ✅ 收到「[@All]」 |
| 正文里写 `@zhuyx`，不传 `--mention` | ❌ **没有任何提醒** |

**提醒由 `--mention` 触发，与正文里的 `@` 字符无关。** 在正文里写 `@张三` 然后
指望它响，是一个静默无效的操作。

两种「看起来成功、实际没@到人」的情况，企微**都返回 `0 ok`**：

- 只在正文里写 `@`，没传 `--mention`
- `--mention` 里的 userid 不存在（企微静默丢弃，不报错）

所以 userid 必须准确 —— 填错不会有任何提示。

`--mention` 挂在文本消息上：只发 `--file` 不发 `--text` 时提醒不到人，要把提醒
放在配套的 `--text` 上。

```bash
# 建群（chatid 可省略由企微生成，但自己指定更利于对照表复现）
corpapp create-internal-group --app 数牍 --name '追货内部群' \
  --owner zhangsan --members lisi,wangwu --chatid chase001

# 查群
corpapp internal-group --app 数牍 --chatid chase001

# 改群：加人 / 减人 / 改名 / 换群主（WeCom 无法解散 appchat 群，所以建错了只能改）
corpapp update-internal-group --app 数牍 --chatid chase001 --add zhaoliu,sunqi
corpapp update-internal-group --app 数牍 --chatid chase001 --del sunqi
corpapp update-internal-group --app 数牍 --chatid chase001 --name '追货内部群(新)'
# --members 是「整体替换」成员名单，不是追加；只想加减人用 --add / --del

# 发消息 / 发文件（文件会先上传再发，可重复 --file）
corpapp send-internal-group --app 数牍 --chatid chase001 \
  --text '今日待办 3 条' --mention zhangsan,lisi --file ./明细.xlsx
```

`--chatid` 限 32 字符内、仅 `0-9a-zA-Z`。owner 会自动并入成员列表；企微要求
**至少 2 个不同成员**。

## 消息队列（group-msg-queue）

发送配额是**在人工确认时**扣掉的，不是创建任务时 —— 而确认时间**完全不可预测**：
可能几分钟，可能跨天，也可能一直不来。因此「这个群今天发过了吗」无法只靠
「已送达记录」回答：一条还在等确认的任务同样占着当天名额。队列就是用来记住这个
「意图」的，**按 corp app 分目录、按群分文件、跨会话持久**。

也正因为配额在确认时才扣，**名额算在哪一天，取决于企微实际发出的那天**
（取自 `send_result` 的 `send_time`），而不是我们占位的那天 —— 当天晚些创建、
次日才被确认的任务，扣的是**次日**的配额。

### 标准循环（顺序有意义）

```bash
APP=数牍

# 1. 超时回收 —— 先结算，再回收「到 --expires-at 仍未送达」的条目
#    已送达（delivered）的不会被回收；结算结果一并返回在 reconciled 里
corpapp group-msg-queue --app $APP --action reap --cancel-wecom

# 2. 业务撤销 —— 调用方查业务数据后自行决定
#    不要加 --state pending：claimed / sent 同样可撤，而 sent 恰恰最该撤
#    （已在等人确认，--cancel-wecom 可赶在确认前撤掉企微侧任务）
corpapp group-msg-queue --app $APP --action list --json
corpapp group-msg-queue --app $APP --action cancel --chat-id wr_xxx \
  --entry-id q_... --reason "排期已取消" --cancel-wecom

# 3. 入队（只存元数据，不存内容）
corpapp group-msg-queue --app $APP --action enqueue --chat-id wr_xxx \
  --meta '{"type":"日常追货提醒","customer_id":"C1024"}' \
  --idempotency-key '日常追货提醒:C1024:2026-08-27' \
  --expires-at 2026-08-26T10:00:00+08:00

# 4. 问「现在哪些群能发」（内部会先结算再判定，结算结果见 reconciled）
corpapp group-msg-queue --app $APP --action next

# 5. 逐条：占位 → 组装 → 发送 → 标记
corpapp group-msg-queue --app $APP --action claim --chat-id wr_xxx --entry-id q_...
# --json 输出 {"ok":true,"msgId":"msg_..."}；mark-sent 只收这个裸 msgId
corpapp send-group --app $APP --sender linqinhui --chat-id wr_xxx --text "..." --file ./x.xlsx --json
corpapp group-msg-queue --app $APP --action mark-sent --chat-id wr_xxx \
  --entry-id q_... --msgid msg_... --sender linqinhui
# 发送失败则归还名额，否则名额空烧一天：
corpapp group-msg-queue --app $APP --action release --chat-id wr_xxx \
  --entry-id q_... --reason "send-group 失败"
```

**`--msgid` 必须是裸 msgid**（`msg_` 开头、无空格），从 `send-group --json` 的 `msgId`
读。脚本若去截取 `send-group` 的文字输出，会把「group message task created  msgid=…」
整句存成 msgid —— 这样的条目永远对不上账，一直占着名额直到过期被回收。服务端现在
会拒绝含空白的 msgid。

**前两步必须跑在 `next` 之前** —— 它们都会释放名额。放到后面，被占住的名额当天不会
释放，那个群就白白锁死一天。

### 合并发送：一条 `mark-sent` 绑多个 entry

每个外部客户群一天只能发一条。若同一天同一个群有多个待发意图（例如日常追货的
事项二/三/四同天撞在一起），可以把它们合并成**一条**企微消息发出，再用**一次**
`mark-sent` 把这几个 entry 全绑到同一个 `--msgid` 上 —— `--entry-id` 传逗号分隔的多个：

```bash
# claim 抢下当天名额（claim 其中任一 entry 即锁住整个群）
corpapp group-msg-queue --app $APP --action claim --chat-id wr_xxx --entry-id q_2
# 组装合并正文（各段用一行 ===== 前后空行隔开）+ 附件，一次发出
corpapp send-group --app $APP --sender linqinhui --chat-id wr_xxx --text "<合并正文>" --file ./x.xlsx
# 把参与合并的所有 entry 一起标 sent，绑同一个 msgid
corpapp group-msg-queue --app $APP --action mark-sent --chat-id wr_xxx   --entry-id q_2,q_3,q_4 --msgid msg_... --sender linqinhui
```

为什么要多 entry 一起 `mark-sent`：这几个意图确实通过这条消息送达了客户，所以都该
记为 `sent`、绑同一个 `msgid`，让对账（reconcile）把它们**全部**算作已送达 —— 而不是
一个 delivered、其余被 `cancel`（那样对账会误以为其余没发）。

约定：
- 一组 entry 里，被 `claim` 的那个是名额持有者（`claimed`），其余是被合并进来的
  （仍 `pending`）—— `mark-sent` 两种状态都接受，因为「并入这条送出」正是花掉它们意图的方式。
- **全有或全无**：任一 entry 缺失或已是 sent/cancelled 等不可并入状态，则整批不写、返回原因，
  不会留下「一半标了、一半没标」。
- 合并这条消息的 `--expires-at`（保留时长）取参与各 entry 里**最短**的那个。
- 每个 entry 的**取消条件各自独立判断**：发送前逐个复核，只把仍满足发送条件的并进正文；
  不满足的单独 `cancel`，不连累其它。

### `reconcile`：只用于排查，标准循环不需要它

`reap` 和 `next` 都会自己先结算，所以正常流程里**不必**单独调用 `reconcile`。
但这两个命令都还会做别的事（`reap` 会取消到期条目；`next` 之后通常紧接着 `claim`）。
`reconcile` 是唯一「只刷新投递事实、不改动其他任何状态」的入口 —— 当你要排查
「这个客户到底收到没有」而又不想扰动队列时用它。

它的输出也是唯一会把 **status 3** 单独讲清楚的：人确认了，但因为当天名额已被另一条
群发占掉，群里什么都没收到。`reap` / `next` 返回的 `reconciled` 只是简要汇总。

```bash
corpapp group-msg-queue --app $APP --action reconcile --chat-id wr_xxx
```

### 两种撤销，刻意分开

| | 依据 | 谁判断 |
|---|---|---|
| `reap` | 先结算，再看「到 `--expires-at` 仍未送达」 | moss，**从不读 `--meta`** |
| `cancel` | 「排期已取消」「客户已回复」等业务条件 | 调用方，需查业务数据 |

过期时刻在入队时按业务算好，**按小时或按天都能表达**（`--expires-at` 是绝对时间戳）。
不传则回退到**该 corp app 配置的队列有效期**（管理后台「企业应用」中按应用设置，
默认 72 小时，范围 1~720）—— 这只是兜底，防止漏传的条目永久占住该群名额
（`next` 会一直以 `pending_exists` 跳过它且不报错）；对时效有要求就显式传。
审批快的租户可以调短，让客户更早收到下一条。

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
