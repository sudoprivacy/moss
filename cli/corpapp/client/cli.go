package client

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// RunOptions tunes the CLI presentation. All fields are optional.
type RunOptions struct {
	// ProgName is the prefix in error messages ("<prog>: ..."). Defaults
	// to "corpapp" if empty.
	ProgName string
	// HelpText is printed for help/--help/-h, after "unknown subcommand",
	// and when no subcommand is given. A generic default is used if empty.
	HelpText string
	// Stdout / Stderr default to os.Stdout / os.Stderr if nil.
	Stdout io.Writer
	Stderr io.Writer
}

const defaultHelpText = `corpapp — Corp App CLI.

Usage:
  corpapp list [--json]
  corpapp get --name <name> | --key <key> [--type <type>] [--json]
  corpapp send --app <name> --to <userid> --text <msg> [--format text|markdown]
  corpapp send-file --app <name> --to <userid> --file <path>
  corpapp receive --app <name> [--since <cursor>] [--limit <n>] [--json]
  corpapp download --app <name> --media-id <id> [--out <path>]
  corpapp approvals --app <name> --start <ts> --end <ts> [--status <n>] [--template <id>] [--cursor <c>] [--size <n>] [--filter key:value ...]
  corpapp approval --app <name> --sp-no <spNo> [--attachments] [--json]

Colored / styled messages:
  Pass --format markdown to enable styling. Plain --format text (the
  default) has no styling at all.

  WeCom supports exactly three colors, via <font color="...">:
    info     green
    comment  gray
    warning  orange

  WeCom has NO red. Use warning (orange) for anything urgent.

  Example:
    corpapp send --app <name> --to <userid> --format markdown \
      --text '<font color="info">OK</font> <font color="warning">2 warnings</font>'`

// Run dispatches a corpapp invocation and returns the process exit code:
//
//	0  success
//	1  request error (HTTP failure, missing args, etc.)
//	2  usage error (no subcommand, unknown subcommand)
//
// Run never calls os.Exit; the caller decides.
func Run(args []string, c *Client, opts RunOptions) int {
	if opts.ProgName == "" {
		opts.ProgName = "corpapp"
	}
	if opts.Stdout == nil {
		opts.Stdout = os.Stdout
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}

	if len(args) < 1 {
		printHelp(opts.Stderr, opts)
		return 2
	}
	sub := args[0]
	rest := args[1:]

	var err error
	switch sub {
	case "list":
		err = runList(rest, c, opts)
	case "get":
		err = runGet(rest, c, opts)
	case "send":
		err = runSend(rest, c, opts)
	case "send-file":
		err = runSendFile(rest, c, opts)
	case "receive":
		err = runReceive(rest, c, opts)
	case "download":
		err = runDownload(rest, c, opts)
	case "approvals":
		err = runApprovals(rest, c, opts)
	case "approval":
		err = runApproval(rest, c, opts)
	case "-h", "--help", "help":
		printHelp(opts.Stdout, opts)
		return 0
	default:
		fmt.Fprintf(opts.Stderr, "%s: unknown subcommand %q\n", opts.ProgName, sub)
		printHelp(opts.Stderr, opts)
		return 2
	}

	if err != nil {
		fmt.Fprintf(opts.Stderr, "%s: %v\n", opts.ProgName, err)
		return 1
	}
	return 0
}

func printHelp(w io.Writer, opts RunOptions) {
	body := opts.HelpText
	if body == "" {
		body = defaultHelpText
	}
	fmt.Fprintln(w, body)
}

// resolveApp turns a user-supplied --app <name> into an app id.
func resolveApp(c *Client, name string) (*CorpApp, error) {
	if name == "" {
		return nil, errors.New("--app <name> is required")
	}
	return c.ResolveByName(name)
}

// ============================================================
// list
// ============================================================

func runList(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "output JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	apps, err := c.List()
	if err != nil {
		return err
	}
	if *jsonOut {
		_ = FormatAppsJSON(opts.Stdout, apps)
		return nil
	}
	FormatApps(opts.Stdout, apps)
	return nil
}

// ============================================================
// get
// ============================================================

func runGet(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("get", flag.ContinueOnError)
	name := fs.String("name", "", "resolve by user-assigned name")
	key := fs.String("key", "", "resolve by key (wecomapp: corpId:agentId)")
	typ := fs.String("type", "", "corp app type for --key (default: wecomapp)")
	jsonOut := fs.Bool("json", false, "output JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *name == "" && *key == "" {
		return errors.New("usage: corpapp get --name <name> | --key <key> [--type <type>]")
	}
	var app *CorpApp
	var err error
	if *name != "" {
		app, err = c.ResolveByName(*name)
	} else {
		app, err = c.ResolveByKey(*typ, *key)
	}
	if err != nil {
		return err
	}
	if *jsonOut {
		return FormatAppJSON(opts.Stdout, app)
	}
	FormatApp(opts.Stdout, app)
	return nil
}

// ============================================================
// send
// ============================================================

func runSend(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("send", flag.ContinueOnError)
	app := fs.String("app", "", "corp app name")
	to := fs.String("to", "", "recipient user id")
	text := fs.String("text", "", "message text")
	format := fs.String("format", "text", "message format: text | markdown")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *app == "" || *to == "" || *text == "" {
		return errors.New("usage: corpapp send --app <name> --to <userid> --text <msg> [--format text|markdown]")
	}
	// Reject unknown formats rather than silently falling back to plain text:
	// a typo like --format markdwon would otherwise send an unstyled message
	// that looks like the colour spans simply did not work.
	if *format != "text" && *format != "markdown" {
		return fmt.Errorf("invalid --format %q: must be \"text\" or \"markdown\"", *format)
	}
	resolved, err := resolveApp(c, *app)
	if err != nil {
		return err
	}
	resp, err := c.SendMessage(resolved.ID, *to, *text, *format)
	if err != nil {
		return err
	}
	FormatSend(opts.Stdout, resp)
	return nil
}

// ============================================================
// send-file
// ============================================================

func runSendFile(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("send-file", flag.ContinueOnError)
	app := fs.String("app", "", "corp app name")
	to := fs.String("to", "", "recipient user id")
	file := fs.String("file", "", "path to the file to send")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *app == "" || *to == "" || *file == "" {
		return errors.New("usage: corpapp send-file --app <name> --to <userid> --file <path>")
	}
	bytes, err := os.ReadFile(*file)
	if err != nil {
		return fmt.Errorf("read file: %w", err)
	}
	resolved, err := resolveApp(c, *app)
	if err != nil {
		return err
	}
	fileName := baseName(*file)
	resp, err := c.SendFile(resolved.ID, *to, fileName, bytes)
	if err != nil {
		return err
	}
	FormatSend(opts.Stdout, resp)
	return nil
}

// ============================================================
// receive
// ============================================================

func runReceive(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("receive", flag.ContinueOnError)
	app := fs.String("app", "", "corp app name")
	since := fs.Int64("since", 0, "cursor: return messages with seq greater than this")
	limit := fs.Int64("limit", 50, "max messages to return")
	jsonOut := fs.Bool("json", false, "output JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *app == "" {
		return errors.New("usage: corpapp receive --app <name> [--since <cursor>] [--limit <n>]")
	}
	resolved, err := resolveApp(c, *app)
	if err != nil {
		return err
	}
	resp, err := c.Inbound(resolved.ID, *since, *limit)
	if err != nil {
		return err
	}
	if *jsonOut {
		return FormatInboundJSON(opts.Stdout, resp)
	}
	FormatInbound(opts.Stdout, resp)
	return nil
}

// ============================================================
// download
// ============================================================

func runDownload(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("download", flag.ContinueOnError)
	app := fs.String("app", "", "corp app name")
	mediaID := fs.String("media-id", "", "media id from a received file/image message")
	out := fs.String("out", "", "output path (file, or directory to use the server filename)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *app == "" || *mediaID == "" {
		return errors.New("usage: corpapp download --app <name> --media-id <id> [--out <path>]")
	}
	resolved, err := resolveApp(c, *app)
	if err != nil {
		return err
	}
	bytes, serverName, err := c.DownloadMedia(resolved.ID, *mediaID)
	if err != nil {
		return err
	}
	// Decide the destination path:
	//   --out a file       -> write there
	//   --out a directory  -> write <dir>/<serverName|mediaId>
	//   no --out           -> write ./<serverName|mediaId>
	name := serverName
	if name == "" {
		name = *mediaID
	}
	dest := *out
	if dest == "" {
		dest = name
	} else if fi, statErr := os.Stat(dest); statErr == nil && fi.IsDir() {
		dest = dest + string(os.PathSeparator) + name
	}
	if err := os.WriteFile(dest, bytes, 0o644); err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	fmt.Fprintf(opts.Stdout, "saved %d bytes to %s\n", len(bytes), dest)
	return nil
}

// ============================================================
// approvals / approval
// ============================================================

// stringsFlag collects a repeatable string flag (e.g. --filter key:value).
type stringsFlag []string

func (s *stringsFlag) String() string { return strings.Join(*s, ",") }
func (s *stringsFlag) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func runApprovals(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("approvals", flag.ContinueOnError)
	app := fs.String("app", "", "corp app name")
	start := fs.Int64("start", 0, "window start (unix seconds)")
	end := fs.Int64("end", 0, "window end (unix seconds)")
	cursor := fs.String("cursor", "", "pagination cursor (empty for first page)")
	size := fs.Int64("size", 0, "page size (provider default when 0)")
	status := fs.String("status", "", "filter by approval status (sp_status): "+ApprovalStatusHelp)
	template := fs.String("template", "", "filter by approval type (template_id)")
	var filters stringsFlag
	fs.Var(&filters, "filter", "extra provider filter as key:value (e.g. creator:zhuyx); repeatable")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *app == "" || *start == 0 || *end == 0 {
		return errors.New("usage: corpapp approvals --app <name> --start <ts> --end <ts> [--status <n>] [--template <id>] [--cursor <c>] [--size <n>] [--filter key:value ...]")
	}
	// Dedicated --status / --template map to WeCom filter entries. Keep
	// --filter for the less-common keys (creator, department, record_type).
	if *status != "" {
		if !ValidApprovalStatus(*status) {
			return fmt.Errorf("invalid --status %q; valid: %s", *status, ApprovalStatusHelp)
		}
		filters = append(filters, "sp_status:"+*status)
	}
	if *template != "" {
		filters = append(filters, "template_id:"+*template)
	}
	resolved, err := resolveApp(c, *app)
	if err != nil {
		return err
	}
	raw, err := c.ListApprovals(resolved.ID, ApprovalListParams{
		Start:   *start,
		End:     *end,
		Cursor:  *cursor,
		Size:    *size,
		Filters: filters,
	})
	if err != nil {
		return err
	}
	return FormatRawJSON(opts.Stdout, raw)
}

func runApproval(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("approval", flag.ContinueOnError)
	app := fs.String("app", "", "corp app name")
	spNo := fs.String("sp-no", "", "approval instance id (WeCom sp_no)")
	attachments := fs.Bool("attachments", false, "list only the downloadable attachments (id/source/label)")
	jsonOut := fs.Bool("json", false, "output JSON (with --attachments: the attachment list as JSON)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *app == "" || *spNo == "" {
		return errors.New("usage: corpapp approval --app <name> --sp-no <spNo> [--attachments] [--json]")
	}
	resolved, err := resolveApp(c, *app)
	if err != nil {
		return err
	}
	raw, err := c.GetApproval(resolved.ID, *spNo)
	if err != nil {
		return err
	}
	// --attachments flattens the three nested WeCom locations (form File
	// controls, comment media, approver-step media) into one list the
	// user can feed straight into `corpapp download --media-id`.
	if *attachments {
		atts, err := ExtractApprovalAttachments(raw)
		if err != nil {
			return err
		}
		if *jsonOut {
			return FormatAttachmentsJSON(opts.Stdout, atts)
		}
		FormatAttachments(opts.Stdout, atts)
		return nil
	}
	return FormatRawJSON(opts.Stdout, raw)
}

// baseName returns the last path segment of p (handles both / and \).
func baseName(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return p[i+1:]
		}
	}
	return p
}
