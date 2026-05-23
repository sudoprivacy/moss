// Command wiki — Document Center CLI used by scode inside the moss runtime
// container. It speaks to moss-server via the agent-facing wiki API and
// authorises every call with SESSION_TOKEN (a short-lived JWT issued by
// moss-server when it spawned this scode session).
//
// Subcommands (kept intentionally small for P0):
//
//	wiki list                          # list wikis the current Assistant can access
//	wiki list --json
//	wiki read <wikiId>                 # read WIKI.md by default
//	wiki read <wikiId> --file <path>   # read a specific .md
//	wiki search <wikiId> <query>       # full-text grep across the wiki
//	wiki metadata <wikiId>             # wiki info (build time, doc count, chunks)
//
// Environment variables (set by moss-server when it spawns scode):
//
//	MOSS_SERVER_URL — base URL, e.g. http://moss-internal:43127
//	SESSION_TOKEN   — bearer token; embeds assistant_id + user_id + org_id
//
// All transport, formatting, and CLI dispatch lives in the importable
// sub-package github.com/sudoprivacy/moss/cli/wiki/client. This file is only
// the moss-specific shell around it: validate the moss env vars, then call
// client.Run.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/sudoprivacy/moss/cli/wiki/client"
)

const (
	envServerURL = "MOSS_SERVER_URL"
	envToken     = "SESSION_TOKEN"
)

const mossHelpText = `wiki — Document Center CLI for use inside the scode runtime.

Usage:
  wiki list [--json]
  wiki read <wikiId> [--file <path>]
  wiki search <wikiId> <query>
  wiki metadata <wikiId>

Environment:
  MOSS_SERVER_URL  base URL of moss-server (set by moss-server when it
                   spawns scode)
  SESSION_TOKEN    bearer JWT with assistant_id/user_id/org_id claims
                   (set by moss-server when it spawns scode)`

func main() {
	base := os.Getenv(envServerURL)
	if strings.TrimRight(base, "/") == "" {
		fmt.Fprintln(os.Stderr, "wiki: "+envServerURL+" is not set; wiki CLI must be launched by moss-server")
		os.Exit(1)
	}
	token := os.Getenv(envToken)
	if token == "" {
		fmt.Fprintln(os.Stderr, "wiki: "+envToken+" is not set; wiki CLI cannot authenticate")
		os.Exit(1)
	}
	c := client.New(base, token)
	os.Exit(client.Run(os.Args[1:], c, client.RunOptions{
		ProgName: "wiki",
		HelpText: mossHelpText,
	}))
}
