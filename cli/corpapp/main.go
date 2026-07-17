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
  corpapp send --app <name> --to <userid> --text <msg>
  corpapp send-file --app <name> --to <userid> --file <path>
  corpapp receive --app <name> [--since <cursor>] [--limit <n>] [--json]
  corpapp download --app <name> --media-id <id> [--out <path>]
  corpapp approvals --app <name> --start <ts> --end <ts> [--status <n>] [--template <id>] [--cursor <c>] [--size <n>] [--filter key:value ...]
  corpapp approval --app <name> --sp-no <spNo> [--attachments] [--json]

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
