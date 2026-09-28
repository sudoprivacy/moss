// Command fetchurl — a curl-compatible front end that routes a skill's HTTP
// request through the moss auth proxy, so the right per-user credential (or a
// freshly minted access_token for login-type services) is injected
// automatically. The skill author never touches the proxy mechanics or any
// credential; they just name the real service URL.
//
// Usage (curl-like):
//
//	fetchurl https://api.acme.com/v1/orders
//	fetchurl -X POST https://api.acme.com/v1/orders -H 'Content-Type: application/json' -d '{"x":1}'
//	fetchurl --token-header Token https://rbox.acme.com/api/list   # minted token as `Token: xxx`
//
// The request is sent to ${SUDOWORK_AUTH_PROXY_URL}/proxy with the real target
// in the X-Remote-URL header; the proxy matches a 凭据 by URL, injects auth, and
// relays the upstream response (status + headers + body) verbatim to stdout.
//
// Environment (set by moss-server when it spawns the session):
//
//	SUDOWORK_AUTH_PROXY_URL   — base URL of the auth proxy
//	SUDOWORK_AUTH_PROXY_TOKEN — per-session bearer token binding calls to the user
package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

const (
	envProxyURL   = "SUDOWORK_AUTH_PROXY_URL"
	envProxyToken = "SUDOWORK_AUTH_PROXY_TOKEN"
)

const helpText = `fetchurl — curl-compatible HTTP via the moss auth proxy.

Usage:
  fetchurl [-X METHOD] [-H 'Header: value']... [-d BODY] [--token-header NAME | --token-query NAME] <url>

Flags:
  -X, --request METHOD       HTTP method (default GET, or POST when -d is given)
  -H, --header  H:V          add a request header (repeatable)
  -d, --data    BODY         request body ('@file' reads BODY from a file)
  -i, --include              include upstream response headers in the output
      --token-header NAME    login-type 凭据 only: send the minted token as
                             'NAME: <token>' (no prefix) for this request
      --token-query NAME     login-type 凭据 only: send the minted token as
                             '?NAME=<token>' for this request
  -h, --help                 show this help

The target <url> is the real service URL; auth is injected by the proxy based on
the 凭据 (credential) configured for that URL. For login-type services the proxy
mints a short-lived access_token from your stored credential automatically and
injects it where the 凭据 says (default 'Authorization: Bearer <token>').

--token-header / --token-query override that placement per request, for one
login-type 凭据 that covers several systems expecting the token differently:
  fetchurl --token-header Token https://rbox.example.com/api/orders
  fetchurl --token-query access_token https://report.example.com/api/export
They are rejected (HTTP 400) for static credentials, whose placement is fixed.

Environment (set by moss-server):
  SUDOWORK_AUTH_PROXY_URL    base URL of the auth proxy
  SUDOWORK_AUTH_PROXY_TOKEN  per-session bearer token`

type options struct {
	method  string
	headers []string
	body    string
	hasBody bool
	include bool
	url     string
	// Per-request placement of a minted token (login-type 凭据 only); at most
	// one is set. Sent to the proxy as X-Token-Header / X-Token-Query.
	tokenHeader string
	tokenQuery  string
}

func parseArgs(args []string) (*options, error) {
	o := &options{method: ""}
	i := 0
	for i < len(args) {
		a := args[i]
		switch {
		case a == "-h" || a == "--help":
			return nil, errHelp
		case a == "-i" || a == "--include":
			o.include = true
		case a == "-X" || a == "--request":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("%s requires a value", a)
			}
			o.method = strings.ToUpper(args[i+1])
			i++
		case a == "-H" || a == "--header":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("%s requires a value", a)
			}
			o.headers = append(o.headers, args[i+1])
			i++
		case a == "--token-header" || a == "--token-query":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("%s requires a value", a)
			}
			name := strings.TrimSpace(args[i+1])
			if name == "" {
				return nil, fmt.Errorf("%s requires a non-empty name", a)
			}
			if a == "--token-header" {
				o.tokenHeader = name
			} else {
				o.tokenQuery = name
			}
			i++
		case a == "-d" || a == "--data":
			if i+1 >= len(args) {
				return nil, fmt.Errorf("%s requires a value", a)
			}
			val := args[i+1]
			if strings.HasPrefix(val, "@") {
				raw, err := os.ReadFile(val[1:])
				if err != nil {
					return nil, fmt.Errorf("read data file: %w", err)
				}
				val = string(raw)
			}
			o.body = val
			o.hasBody = true
			i++
		case strings.HasPrefix(a, "-") && a != "-":
			return nil, fmt.Errorf("unknown flag %q", a)
		default:
			if o.url != "" {
				return nil, fmt.Errorf("multiple URLs given (%q and %q)", o.url, a)
			}
			o.url = a
		}
		i++
	}
	if o.url == "" {
		return nil, fmt.Errorf("no URL given")
	}
	if o.tokenHeader != "" && o.tokenQuery != "" {
		return nil, fmt.Errorf("--token-header and --token-query are mutually exclusive")
	}
	if o.method == "" {
		if o.hasBody {
			o.method = "POST"
		} else {
			o.method = "GET"
		}
	}
	return o, nil
}

var errHelp = fmt.Errorf("help")

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	o, err := parseArgs(args)
	if err == errHelp {
		fmt.Fprintln(os.Stdout, helpText)
		return 0
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetchurl: %v\n", err)
		fmt.Fprintln(os.Stderr, helpText)
		return 2
	}

	base := strings.TrimRight(os.Getenv(envProxyURL), "/")
	if base == "" {
		fmt.Fprintln(os.Stderr, "fetchurl: "+envProxyURL+" is not set; fetchurl must be launched inside a moss session")
		return 1
	}
	token := os.Getenv(envProxyToken)
	if token == "" {
		fmt.Fprintln(os.Stderr, "fetchurl: "+envProxyToken+" is not set; cannot authenticate to the auth proxy")
		return 1
	}

	var bodyReader io.Reader
	if o.hasBody {
		bodyReader = strings.NewReader(o.body)
	}
	// Always POST to the proxy's /proxy endpoint; the real upstream method
	// travels in X-Remote-Method so a GET/PUT/DELETE upstream is preserved.
	req, err := http.NewRequest(http.MethodPost, base+"/proxy", bodyReader)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetchurl: %v\n", err)
		return 1
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Remote-URL", o.url)
	req.Header.Set("X-Remote-Method", o.method)
	for _, h := range o.headers {
		k, v, ok := strings.Cut(h, ":")
		if !ok {
			fmt.Fprintf(os.Stderr, "fetchurl: bad header %q (want 'Name: value')\n", h)
			return 2
		}
		req.Header.Set(strings.TrimSpace(k), strings.TrimSpace(v))
	}
	// Set after -H so a user header can't clobber these proxy control headers.
	if o.tokenHeader != "" {
		req.Header.Set("X-Token-Header", o.tokenHeader)
	}
	if o.tokenQuery != "" {
		req.Header.Set("X-Token-Query", o.tokenQuery)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fetchurl: %v\n", err)
		return 1
	}
	defer resp.Body.Close()

	if o.include {
		fmt.Fprintf(os.Stdout, "HTTP %s\n", resp.Status)
		for k, vs := range resp.Header {
			for _, v := range vs {
				fmt.Fprintf(os.Stdout, "%s: %s\n", k, v)
			}
		}
		fmt.Fprintln(os.Stdout)
	}
	if _, err := io.Copy(os.Stdout, resp.Body); err != nil {
		fmt.Fprintf(os.Stderr, "fetchurl: %v\n", err)
		return 1
	}
	// Surface non-2xx as a non-zero exit so skills can detect failures (e.g. a
	// 403 mint_failed when the user must set/refresh their credential).
	if resp.StatusCode >= 400 {
		return 22 // mirrors curl's --fail exit code
	}
	return 0
}
