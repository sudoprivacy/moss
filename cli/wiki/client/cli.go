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
	// ProgName is used as the prefix in error messages ("<prog>: ...").
	// Defaults to "wiki" if empty.
	ProgName string

	// HelpText is printed for `help`, `--help`, `-h`, after "unknown
	// subcommand", and when no subcommand is given. If empty, a generic
	// default is used.
	HelpText string

	// Stdout / Stderr default to os.Stdout / os.Stderr if nil. Exposed
	// mainly for tests.
	Stdout io.Writer
	Stderr io.Writer
}

const defaultHelpText = `wiki — Document Center CLI.

Usage:
  wiki list [--json]
  wiki read <wikiId> [--file <path>] [--list]
  wiki search <wikiId> <query>
  wiki metadata <wikiId>`

// Run dispatches a wiki CLI invocation and returns the process exit code:
//
//	0  success
//	1  request error (HTTP failure, missing args, etc.)
//	2  usage error (no subcommand, unknown subcommand)
//
// Run never calls os.Exit; the caller decides. Typical use from a downstream
// main.go is `os.Exit(client.Run(os.Args[1:], c, opts))`.
func Run(args []string, c *Client, opts RunOptions) int {
	if opts.ProgName == "" {
		opts.ProgName = "wiki"
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
	case "read":
		err = runRead(rest, c, opts)
	case "search":
		err = runSearch(rest, c, opts)
	case "metadata":
		err = runMetadata(rest, c, opts)
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

// ============================================================
// list
// ============================================================

func runList(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "output JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	wikis, err := c.ListWikis()
	if err != nil {
		return err
	}
	if *jsonOut {
		// Match historical behavior: marshal error is silently swallowed
		// (the fixed schema cannot fail to marshal in practice).
		_ = FormatWikiListJSON(opts.Stdout, wikis)
		return nil
	}
	FormatWikiList(opts.Stdout, wikis)
	return nil
}

// ============================================================
// read
// ============================================================

func runRead(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("read", flag.ContinueOnError)
	filePath := fs.String("file", "WIKI.md", "path inside the wiki dir (default: WIKI.md)")
	listFiles := fs.Bool("list", false, "list files in the wiki, do not read content")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return errors.New("usage: wiki read <wikiId> [--file <path>] [--list]")
	}
	wikiID := fs.Arg(0)
	if *listFiles {
		files, err := c.ListFiles(wikiID)
		if err != nil {
			return err
		}
		for _, f := range files {
			fmt.Fprintln(opts.Stdout, f)
		}
		return nil
	}
	resp, err := c.ReadFile(wikiID, *filePath)
	if err != nil {
		return err
	}
	fmt.Fprint(opts.Stdout, resp.Content)
	if !strings.HasSuffix(resp.Content, "\n") {
		fmt.Fprintln(opts.Stdout)
	}
	return nil
}

// ============================================================
// search
// ============================================================

func runSearch(args []string, c *Client, opts RunOptions) error {
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	contextLines := fs.Int("context", 0, "lines of context around each match (P0: server-side ignored)")
	_ = contextLines
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() < 2 {
		return errors.New("usage: wiki search <wikiId> <query>")
	}
	wikiID := fs.Arg(0)
	query := strings.Join(fs.Args()[1:], " ")
	resp, err := c.Search(wikiID, query)
	if err != nil {
		return err
	}
	FormatSearchMatches(opts.Stdout, resp.Matches)
	return nil
}

// ============================================================
// metadata
// ============================================================

func runMetadata(args []string, c *Client, opts RunOptions) error {
	if len(args) < 1 {
		return errors.New("usage: wiki metadata <wikiId>")
	}
	wikiID := args[0]
	resp, err := c.Metadata(wikiID)
	if err != nil {
		return err
	}
	FormatMetadata(opts.Stdout, resp)
	return nil
}
