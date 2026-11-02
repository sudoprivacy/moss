// Command agentctl — agent home and agent-to-agent collaboration CLI used by
// scode inside the moss runtime container. It talks to moss-server's
// /api/v1/agent/agentify endpoints and authorises every call with
// SESSION_TOKEN, which moss-server binds to this agent and session.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const helpText = `agentctl — your agent home (memory, history, outputs) and colleague agents.

Memory and history:
  agentctl recall "<question or keywords>" [--kind summary,artifact] [--limit 8]
  agentctl history list [--limit 20]
  agentctl history show <id>
  agentctl memory list
  agentctl memory add "<fact>" [--private]
  agentctl files get <path> [--out <file>]

Colleague agents:
  agentctl agents
  agentctl ask --agent <name> --capability <id> "<question>" [--timeout 600]
  agentctl delegate --agent <name> --capability <id> "<task>" [--wait] [--timeout 1800]
  agentctl call <callId> [--wait]
  agentctl cancel <callId>
  agentctl recall --agent <name> "<keywords>"      # its shared history
  agentctl files get --agent <name> <path> [--out <file>]

Every command accepts --json for machine-readable output.

Environment (set by moss-server when it starts the session):
  MOSS_SERVER_URL   base URL of moss-server
  SESSION_TOKEN     bearer token bound to this agent and session`

// Run executes one command; returns the process exit code.
func Run(args []string, c *Client, stdout, stderr io.Writer, sleep func(time.Duration)) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintln(stdout, helpText)
		return 0
	}
	err := dispatch(args, c, stdout, sleep)
	if err == nil {
		return 0
	}
	var api *APIError
	if errors.As(err, &api) {
		fmt.Fprintf(stderr, "agentctl: %s\n", api.Error())
		return 2
	}
	fmt.Fprintf(stderr, "agentctl: %v\n", err)
	return 1
}

// parse lets flags appear before or after positional arguments.
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			break
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
	return positional, nil
}

func printJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func day(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04")
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func printCall(w io.Writer, call Call) {
	fmt.Fprintf(w, "call %s  %s %s/%s  status=%s\n", call.ID, call.Kind, call.Target.Name, call.Capability, call.Status)
	if call.Result != nil && *call.Result != "" {
		fmt.Fprintf(w, "\n%s\n", *call.Result)
	}
	if call.Error != nil && *call.Error != "" {
		fmt.Fprintf(w, "\nerror: %s\n", *call.Error)
	}
	if len(call.Files) > 0 {
		fmt.Fprintln(w, "\nfiles (fetch with `agentctl files get --agent "+call.Target.Name+" <path>`):")
		for _, f := range call.Files {
			fmt.Fprintf(w, "  %s\n", f)
		}
	}
}

func joinText(positional []string) string {
	return strings.TrimSpace(strings.Join(positional, " "))
}

func dispatch(args []string, c *Client, out io.Writer, sleep func(time.Duration)) error {
	cmd, rest := args[0], args[1:]
	fs := flag.NewFlagSet("agentctl "+cmd, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	asJSON := fs.Bool("json", false, "")

	switch cmd {
	case "recall":
		agent := fs.String("agent", "", "")
		kind := fs.String("kind", "", "")
		limit := fs.Int("limit", 8, "")
		pos, err := parse(fs, rest)
		if err != nil {
			return err
		}
		query := joinText(pos)
		if query == "" {
			return errors.New(`usage: agentctl recall "<question or keywords>"`)
		}
		hits, err := c.Recall(query, *agent, *kind, *limit)
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(out, hits)
		}
		if len(hits) == 0 {
			fmt.Fprintln(out, "no matching history")
			return nil
		}
		for _, h := range hits {
			fmt.Fprintf(out, "[%s] %s  %s  (id %s)\n%s\n\n", h.Kind, day(h.CreatedAt), h.Title, short(h.ID), strings.TrimSpace(h.Snippet))
		}
		return nil

	case "history":
		if len(rest) == 0 {
			return errors.New("usage: agentctl history list | show <id>")
		}
		sub := rest[0]
		limit := fs.Int("limit", 20, "")
		pos, err := parse(fs, rest[1:])
		if err != nil {
			return err
		}
		switch sub {
		case "list":
			items, err := c.History(*limit)
			if err != nil {
				return err
			}
			if *asJSON {
				return printJSON(out, items)
			}
			for _, it := range items {
				fmt.Fprintf(out, "%s  %s  [%s] %s\n", short(it.ID), day(it.CreatedAt), it.Kind, it.Title)
			}
			return nil
		case "show":
			if len(pos) != 1 {
				return errors.New("usage: agentctl history show <id>")
			}
			item, err := c.HistoryShow(pos[0])
			if err != nil {
				return err
			}
			if *asJSON {
				return printJSON(out, item)
			}
			fmt.Fprintln(out, item.Text)
			return nil
		}
		return fmt.Errorf("unknown history command %q", sub)

	case "memory":
		if len(rest) == 0 {
			return errors.New(`usage: agentctl memory list | add "<fact>" [--private]`)
		}
		sub := rest[0]
		private := fs.Bool("private", false, "")
		pos, err := parse(fs, rest[1:])
		if err != nil {
			return err
		}
		switch sub {
		case "list":
			shared, mine, err := c.Memory()
			if err != nil {
				return err
			}
			if *asJSON {
				return printJSON(out, map[string]string{"shared": shared, "private": mine})
			}
			fmt.Fprintf(out, "%s\n%s\n", strings.TrimSpace(shared), strings.TrimSpace(mine))
			return nil
		case "add":
			text := joinText(pos)
			if text == "" {
				return errors.New(`usage: agentctl memory add "<fact>" [--private]`)
			}
			if err := c.MemoryAdd(text, *private); err != nil {
				return err
			}
			fmt.Fprintln(out, "remembered")
			return nil
		}
		return fmt.Errorf("unknown memory command %q", sub)

	case "files":
		if len(rest) == 0 || rest[0] != "get" {
			return errors.New("usage: agentctl files get [--agent <name>] <path> [--out <file>]")
		}
		agent := fs.String("agent", "", "")
		outPath := fs.String("out", "", "")
		pos, err := parse(fs, rest[1:])
		if err != nil {
			return err
		}
		if len(pos) != 1 {
			return errors.New("usage: agentctl files get [--agent <name>] <path> [--out <file>]")
		}
		data, err := c.File(*agent, pos[0])
		if err != nil {
			return err
		}
		target := *outPath
		if target == "" {
			target = filepath.Base(pos[0])
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
		fmt.Fprintf(out, "saved %s (%d bytes)\n", target, len(data))
		return nil

	case "agents":
		if _, err := parse(fs, rest); err != nil {
			return err
		}
		agents, err := c.Agents()
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(out, agents)
		}
		if len(agents) == 0 {
			fmt.Fprintln(out, "no colleague agents are open to you")
			return nil
		}
		for _, a := range agents {
			fmt.Fprintf(out, "%s (%s)\n", a.DisplayName, a.Name)
			if a.Description != "" {
				fmt.Fprintf(out, "  %s\n", a.Description)
			}
			for _, cap := range a.Capabilities {
				verb := "ask"
				if cap.Kind == "task" {
					verb = "delegate"
				}
				extra := ""
				if cap.RequiresConfirmation {
					extra = " [needs human confirmation]"
				}
				fmt.Fprintf(out, "  %s %s: %s%s\n", verb, cap.ID, cap.Description, extra)
			}
			if a.CanReadHistory {
				fmt.Fprintln(out, "  history: readable with --agent")
			}
		}
		return nil

	case "ask", "delegate":
		agent := fs.String("agent", "", "")
		capability := fs.String("capability", "", "")
		idem := fs.String("idempotency-key", "", "")
		wait := fs.Bool("wait", cmd == "ask", "")
		defTimeout := 600
		if cmd == "delegate" {
			defTimeout = 1800
		}
		timeout := fs.Int("timeout", defTimeout, "")
		pos, err := parse(fs, rest)
		if err != nil {
			return err
		}
		text := joinText(pos)
		if *agent == "" || *capability == "" || text == "" {
			return fmt.Errorf(`usage: agentctl %s --agent <name> --capability <id> "<text>"`, cmd)
		}
		var call Call
		if cmd == "ask" {
			call, err = c.Ask(*agent, *capability, text, *idem)
		} else {
			call, err = c.Delegate(*agent, *capability, text, *idem)
		}
		if err != nil {
			return err
		}
		if *wait && !call.Terminal() && call.Status != "pending_confirmation" {
			call, err = c.Wait(call.ID, time.Duration(*timeout)*time.Second, 3*time.Second, sleep)
			if err != nil {
				printCall(out, call)
				return err
			}
		}
		if *asJSON {
			return printJSON(out, call)
		}
		printCall(out, call)
		if call.Status == "pending_confirmation" {
			fmt.Fprintln(out, "\nwaiting for a person to confirm; check with `agentctl call "+call.ID+"`")
		}
		if call.Status == "failed" || call.Status == "rejected" || call.Status == "expired" {
			return fmt.Errorf("call %s", call.Status)
		}
		return nil

	case "call", "cancel":
		wait := fs.Bool("wait", false, "")
		timeout := fs.Int("timeout", 1800, "")
		pos, err := parse(fs, rest)
		if err != nil {
			return err
		}
		if len(pos) != 1 {
			return fmt.Errorf("usage: agentctl %s <callId>", cmd)
		}
		var call Call
		if cmd == "cancel" {
			call, err = c.Cancel(pos[0])
		} else if *wait {
			call, err = c.Wait(pos[0], time.Duration(*timeout)*time.Second, 3*time.Second, sleep)
		} else {
			call, err = c.GetCall(pos[0])
		}
		if err != nil {
			return err
		}
		if *asJSON {
			return printJSON(out, call)
		}
		printCall(out, call)
		return nil

	case "whoami":
		var who map[string]any
		if err := c.getJSON("/whoami", nil, &who); err != nil {
			return err
		}
		return printJSON(out, who)
	}
	return fmt.Errorf("unknown command %q (see agentctl --help)", cmd)
}

func main() {
	if len(os.Args) < 2 || os.Args[1] == "-h" || os.Args[1] == "--help" || os.Args[1] == "help" {
		fmt.Println(helpText)
		return
	}
	base := os.Getenv("MOSS_SERVER_URL")
	if strings.TrimRight(base, "/") == "" {
		fmt.Fprintln(os.Stderr, "agentctl: MOSS_SERVER_URL is not set; agentctl must be launched by moss-server")
		os.Exit(1)
	}
	token := os.Getenv("SESSION_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "agentctl: SESSION_TOKEN is not set; agentctl cannot authenticate")
		os.Exit(1)
	}
	os.Exit(Run(os.Args[1:], NewClient(base, token), os.Stdout, os.Stderr, time.Sleep))
}
