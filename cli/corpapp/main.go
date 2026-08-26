// Command corpapp — Corp App (企业应用) CLI used by scode inside the moss
// runtime container. It speaks to moss-server via the agent-facing
// corp-app API and authorises every call with SESSION_TOKEN (a
// short-lived JWT issued by moss-server when it spawned this scode
// session).
//
// Subcommands:
//
//	corpapp list                                              # apps this assistant can use
//	corpapp get --name <name>                                 # resolve an app by name
//	corpapp get --key <key> [--type <type>]                   # resolve an app by key
//	corpapp send --app <name> --to <userid> --text <msg>      # send a text message
//	corpapp send-file --app <name> --to <userid> --file <p>   # send a file
//	corpapp receive --app <name> [--since <cursor>]           # poll inbound messages
//	corpapp download --app <name> --media-id <id> [--out <p>] # download received media
//	corpapp approvals --app <name> --start <ts> --end <ts>    # list approval ids (审批单号)
//	corpapp approvals ... --status <n> --template <id>       # filter by status / type
//	corpapp approval --app <name> --sp-no <spNo>              # get one approval's full detail
//	corpapp approval --app <name> --sp-no <spNo> --attachments # list its downloadable files (id/source/label)
//	corpapp groups --app <name> [--owner <userid,...>]        # list customer groups (客户群)
//	corpapp group --app <name> --chat-id <id>                 # one group's detail + members
//	corpapp send-group --app <name> --sender <userid> --chat-id <id> --text <msg>
//	                                                          # create a 群发 task (needs human confirmation)
//	corpapp group-msg-result --app <name> --msgid <id> --userid <userid>
//	                                                          # per-group delivery status
//	corpapp group-msg-remind --app <name> --msgid <id>        # nudge the sender to confirm
//
// The CLI is generic across corp-app types; capabilities are per-type
// (returned by the server), so a `send`/`receive` against a type that
// doesn't support it yields a clear error.
//
// Environment variables (set by moss-server when it spawns scode):
//
//	MOSS_SERVER_URL — base URL, e.g. http://moss-internal:43127
//	SESSION_TOKEN   — bearer token; embeds assistant_id + user_id + org_id
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/sudoprivacy/moss/cli/corpapp/client"
)

const (
	envServerURL = "MOSS_SERVER_URL"
	envToken     = "SESSION_TOKEN"
)

const mossHelpText = `corpapp — Corp App (企业应用) CLI for use inside the scode runtime.

Usage:
  corpapp list [--json]
  corpapp get --name <name> | --key <key> [--type <type>] [--json]
  corpapp send --app <name> --to <userid> --text <msg> [--format text|markdown]
  corpapp send-file --app <name> --to <userid> --file <path>
  corpapp receive --app <name> [--since <cursor>] [--limit <n>] [--json]
  corpapp download --app <name> --media-id <id> [--out <path>]
  corpapp approvals --app <name> --start <ts> --end <ts> [--status <n>] [--template <id>] [--cursor <c>] [--size <n>] [--filter key:value ...]
  corpapp approval --app <name> --sp-no <spNo> [--attachments] [--json]
  corpapp groups --app <name> [--owner <userid,...>] [--cursor <c>] [--limit <n>]
  corpapp group --app <name> --chat-id <id> [--no-name]
  corpapp send-group --app <name> --sender <userid> --chat-id <id> [--chat-id <id>...] [--text <msg>] [--file <path>...] [--media-id <id>...]
                     [--cap-window calendar|rolling24h] [--skip-capped] [--no-cap-check]
  corpapp group-msgs --app <name> --start <ts> --end <ts> [--creator <userid>]
  corpapp group-msg-result --app <name> --msgid <id> --userid <userid> [--cursor <c>]
  corpapp group-msg-summary --app <name> --msgid <id> --userid <userid> [--json]
  corpapp group-msg-task --app <name> --msgid <id> [--cursor <c>]
  corpapp group-msg-remind --app <name> --msgid <id>
  corpapp group-msg-queue --app <name> --action <verb> [--chat-id <id>] [--entry-id <id>] ...
                     verbs: enqueue|next|claim|release|mark-sent|cancel|reap|reconcile|list

Colored / styled messages:
  --format markdown enables styling. --format text (the default) has no
  styling at all.

  WeCom supports exactly three colors, via <font color="...">:
    info     green
    comment  gray
    warning  orange

  WeCom has NO red — use warning (orange) for anything urgent.

  Example:
    corpapp send --app myapp --to zhangsan --format markdown \
      --text '<font color="info">通过</font> <font color="warning">2 项告警</font>'

Customer groups and 群发 (WeCom):
  groups/group read 客户群. Visibility is decided by the GROUP OWNER: a group
  whose 群主 is outside the app's visible range is silently missing from
  the groups output — no error, just a short list. Without --owner the provider walks
  every owner in range and fails with 81017 past 1000 people, so large tenants
  should page with --owner (max 100 userids per call).

  group prints the member list, where type 1 is internal staff (real userid)
  and type 2 is an external contact (opaque external_userid).

  send-group does NOT send. It creates a task that a human must confirm in
  企微 群发助手, and tasks created through the API are recorded as 企业发表,
  which an administrator must approve before the sender is even notified.
  --sender must be an internal staff userid who is already in the target group.

  THE DAILY CAP — the sharpest edge here. A customer group accepts only ONE
  群发 per day. A second same-day task is NOT rejected at creation: it returns
  errcode 0 with a valid msgid, an admin approves it, the sender taps send,
  and group-msg-task then reports 已发送 — yet the group receives nothing.
  Only the send result exposes it, as status 3.

  send-group therefore GUARDS against this before doing anything: it
  reconstructs which of your targets already received a broadcast in the
  window and refuses with a non-zero exit rather than queueing a doomed task.

    --cap-window calendar    (default) quota resets at provider midnight,
                             evaluated in Asia/Shanghai — the provider's clock,
                             not yours
    --cap-window rolling24h  stricter: looks back a rolling 24h, so a 23:50
                             send still blocks 00:10 the next morning
    --skip-capped            drop blocked targets, send to the rest
    --no-cap-check           skip the check entirely (the provider will still
                             silently drop over-quota targets)

  Which boundary the provider actually uses is NOT documented. calendar
  matches its wording; rolling24h is the safe choice if you schedule near
  midnight.

  A group is blocked if it ALREADY RECEIVED a broadcast in the window, or if an
  unconfirmed task targets it. The second case matters because quota is spent at
  confirmation, not creation: a task created at 08:10 once passed a
  delivered-only check because the task ahead of it was not confirmed until
  10:18 — then it settled as status 3, wasting a confirmation. Pending tasks
  block regardless of age, since one confirmed after midnight spends the new
  day's quota. Cancelling the outstanding task frees the slot.

  So a human spends a confirmation click on a message that goes nowhere.
  Always reconcile with:

    corpapp group-msg-summary --app myapp --msgid <id> --userid <sender>

  which counts delivered/pending/failed and flags targets dropped by the cap.
  Never treat group-msg-task (per member: "the human clicked send") as proof
  of delivery — use group-msg-result / group-msg-summary (per group).

  The reset is enforced by the provider on China time (Asia/Shanghai), not by
  this CLI, and whether it is a calendar-day or rolling-24h boundary is not
  documented — schedule campaigns well clear of midnight rather than
  assuming either.

    corpapp send-group --app myapp --sender zhangsan \
      --chat-id wr_xxx --text '本周报表' --file ./report.pdf

The message queue (group-msg-queue):
  The daily cap is spent when a human CONFIRMS a task, not when the API creates
  one — and confirmation can land hours later. So "has this group been sent to
  today?" cannot be answered by looking at delivered broadcasts alone. The queue
  remembers intent across runs, per corp app, per group.

  Standard loop (the order matters — the first three all RELEASE slots, so
  running them after next would leave groups needlessly locked for the day):

    1. reap                  withdraw entries past their own --expires-at
    2. list --state pending  caller applies business rules -> cancel
    3. reconcile             settle sent entries against what WeCom delivered
    4. enqueue               queue new intents (idempotency-key makes re-runs safe)
    5. next                  ask which groups may be sent to now
    6. per entry: claim -> compose -> send-group -> mark-sent
                  (on failure: release, so the slot is not burned)
    7. list --state failed   caller decides whether to re-queue

  TWO KINDS OF CANCELLATION, deliberately separate:
    reap    knows only HOW LONG — it compares each entry's --expires-at to now
            and never reads --meta. Set the deadline per entry at enqueue time;
            hours and days are equally expressible.
    cancel  knows WHY — "the schedule moved", "the customer already replied".
            That needs fresh business data, so the caller drives it via
            list --state pending, then cancel --reason.

  claim before composing: building a report can take a minute, and without the
  slot held a second agent could pass next for the same group. Both would
  send; the loser dies as status 3 after a human confirmed it.

  next never truncates silently: totalEligible and hasMore are always reported,
  and every held-back group appears in skipped with its reason. Use --limit as
  deliberate pacing — each send costs an admin approval plus a confirmation.

  status 3 is NOT auto-requeued. The entry becomes failed and the slot is
  freed, but whether it is still worth sending tomorrow is a business call.

  Example:

    corpapp group-msg-queue --app myapp --action enqueue --chat-id wr_xxx \
      --meta '{"type":"daily_chase","customer_id":"C1024"}' \
      --idempotency-key 'daily_chase:C1024:2026-08-27' \
      --expires-at 2026-08-26T10:00:00+08:00

Filtering approvals:
  --status <n>    approval status (sp_status):
                  1=审批中 2=已通过 3=已驳回 4=已撤销 6=通过后撤销 7=已删除 10=已支付
  --template <id> approval type (template_id)
  --filter k:v    any other WeCom filter (creator, department, record_type);
                  repeatable. Different keys AND together.

Attachments:
  corpapp approval --app <name> --sp-no <spNo> --attachments
    lists every downloadable file on the approval (form fields, comments,
    approver steps) as: KIND  SOURCE  ID  LABEL. Feed an ID straight into:
  corpapp download --app <name> --media-id <ID> --out ./

Note:
  approvals/approval require this app to be added under
  审批 → 「可调用接口的应用」 in the WeCom admin console.

Environment:
  MOSS_SERVER_URL  base URL of moss-server (set by moss-server when it
                   spawns scode)
  SESSION_TOKEN    bearer JWT with assistant_id/user_id/org_id claims
                   (set by moss-server when it spawns scode)`

func main() {
	base := os.Getenv(envServerURL)
	if strings.TrimRight(base, "/") == "" {
		fmt.Fprintln(os.Stderr, "corpapp: "+envServerURL+" is not set; corpapp CLI must be launched by moss-server")
		os.Exit(1)
	}
	token := os.Getenv(envToken)
	if token == "" {
		fmt.Fprintln(os.Stderr, "corpapp: "+envToken+" is not set; corpapp CLI cannot authenticate")
		os.Exit(1)
	}
	c := client.New(base, token)
	os.Exit(client.Run(os.Args[1:], c, client.RunOptions{
		ProgName: "corpapp",
		HelpText: mossHelpText,
	}))
}
