// Package client is a Go client + CLI entry point for the wiki/Document
// Center HTTP API. It speaks the same JSON contract the moss-server agent
// endpoints expose, but knows nothing about moss itself: no env-var lookups,
// no os.Exit, no moss-specific help text.
//
// Other Go projects can import it as github.com/sudoprivacy/moss/cli/wiki/client
// and either drive the typed API directly or build a `wiki` binary by calling
// Run from a tiny main.go.
package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultPathPrefix is the API path the moss-server mounts the agent-facing
// wiki endpoints under. Override Client.PathPrefix for servers using a
// different mount.
const DefaultPathPrefix = "/api/v1/agent/wikis"

// Client is an HTTP client for the wiki API. Construct with New; fields are
// exported so callers can swap the HTTP client (e.g. for tests) or override
// the path prefix after construction.
type Client struct {
	BaseURL    string
	Token      string
	PathPrefix string
	HTTP       *http.Client
}

// New returns a Client that sends Authorization: Bearer <token> on every
// request. Defaults: trailing-slash-trimmed BaseURL, DefaultPathPrefix, and
// a 30-second HTTP timeout.
func New(baseURL, token string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		Token:      token,
		PathPrefix: DefaultPathPrefix,
		HTTP:       &http.Client{Timeout: 30 * time.Second},
	}
}

// NewNoAuth returns a Client that sends no Authorization header. Use this
// against wiki servers that don't require authentication.
func NewNoAuth(baseURL string) *Client {
	return New(baseURL, "")
}

func (c *Client) get(path string, out any) error {
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// ============================================================
// Response types — mirror server JSON
// ============================================================

type WikiSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	BuildStatus string `json:"buildStatus"`
}

type WikisListResp struct {
	Wikis []WikiSummary `json:"wikis"`
}

type WikiFilesResp struct {
	WikiID string   `json:"wiki_id"`
	Files  []string `json:"files"`
}

type WikiFileResp struct {
	WikiID  string `json:"wiki_id"`
	Path    string `json:"path"`
	Content string `json:"content"`
}

type SearchMatch struct {
	File   string `json:"file"`
	LineNo int    `json:"line_no"`
	Line   string `json:"line"`
}

type SearchResp struct {
	WikiID  string        `json:"wiki_id"`
	Query   string        `json:"query"`
	Matches []SearchMatch `json:"matches"`
}

type MetadataResp struct {
	WikiID              string `json:"wiki_id"`
	Name                string `json:"name"`
	Description         string `json:"description"`
	BuildStatus         string `json:"build_status"`
	LastBuiltAt         *int64 `json:"last_built_at"`
	SourceDocumentCount int    `json:"source_document_count"`
	ChunkCount          int    `json:"chunk_count"`
}

// ============================================================
// Request methods
// ============================================================

// ListWikis returns the wikis visible to the bearer token.
func (c *Client) ListWikis() ([]WikiSummary, error) {
	var resp WikisListResp
	if err := c.get(c.PathPrefix, &resp); err != nil {
		return nil, err
	}
	return resp.Wikis, nil
}

// ListFiles returns the file paths inside the given wiki.
func (c *Client) ListFiles(wikiID string) ([]string, error) {
	if wikiID == "" {
		return nil, errors.New("wikiID is required")
	}
	var resp WikiFilesResp
	if err := c.get(c.PathPrefix+"/"+url.PathEscape(wikiID)+"/files", &resp); err != nil {
		return nil, err
	}
	return resp.Files, nil
}

// ReadFile returns the content of a single file inside the wiki. filePath is
// a "/"-separated path like "WIKI.md" or "images/fig-001.png".
func (c *Client) ReadFile(wikiID, filePath string) (*WikiFileResp, error) {
	if wikiID == "" {
		return nil, errors.New("wikiID is required")
	}
	if filePath == "" {
		return nil, errors.New("filePath is required")
	}
	var resp WikiFileResp
	endpoint := c.PathPrefix + "/" + url.PathEscape(wikiID) + "/files/" + escapePath(filePath)
	if err := c.get(endpoint, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Search runs a full-text query against the wiki and returns matches.
func (c *Client) Search(wikiID, query string) (*SearchResp, error) {
	if wikiID == "" {
		return nil, errors.New("wikiID is required")
	}
	q := url.Values{}
	q.Set("q", query)
	endpoint := c.PathPrefix + "/" + url.PathEscape(wikiID) + "/search?" + q.Encode()
	var resp SearchResp
	if err := c.get(endpoint, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Metadata returns build status and counts for the wiki.
func (c *Client) Metadata(wikiID string) (*MetadataResp, error) {
	if wikiID == "" {
		return nil, errors.New("wikiID is required")
	}
	var resp MetadataResp
	if err := c.get(c.PathPrefix+"/"+url.PathEscape(wikiID)+"/metadata", &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// escapePath encodes each path segment but keeps "/" — so callers can pass
// nested paths like `images/fig-001.png` without losing the structure.
func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, seg := range parts {
		parts[i] = url.PathEscape(seg)
	}
	return strings.Join(parts, "/")
}
