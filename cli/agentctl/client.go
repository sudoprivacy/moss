package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const pathPrefix = "/api/v1/agent/agentify"

// Client talks to moss-server's agentify endpoints with the session token.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    &http.Client{Timeout: 60 * time.Second},
	}
}

// APIError is a non-2xx answer from moss-server.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s (%s, HTTP %d)", e.Message, e.Code, e.Status)
	}
	return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status)
}

func (c *Client) do(method, path string, query url.Values, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	full := c.BaseURL + pathPrefix + path
	if len(query) > 0 {
		full += "?" + query.Encode()
	}
	req, err := http.NewRequest(method, full, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var env struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &env) == nil && env.Error.Message != "" {
			return nil, &APIError{Status: resp.StatusCode, Code: env.Error.Code, Message: env.Error.Message}
		}
		return nil, &APIError{Status: resp.StatusCode, Message: strings.TrimSpace(string(data))}
	}
	return data, nil
}

func (c *Client) getJSON(path string, query url.Values, out any) error {
	data, err := c.do(http.MethodGet, path, query, nil)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func (c *Client) postJSON(path string, body any, out any) error {
	data, err := c.do(http.MethodPost, path, nil, body)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

// ---- response shapes ----

type Hit struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Path      string  `json:"path"`
	SessionID *string `json:"sessionId"`
	CreatedAt int64   `json:"createdAt"`
	Origin    string  `json:"origin,omitempty"`
	Score     float64 `json:"score"`
	Snippet   string  `json:"snippet"`
}

type HistoryItem struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Path      string  `json:"path"`
	SessionID *string `json:"sessionId"`
	CreatedAt int64   `json:"createdAt"`
	Origin    string  `json:"origin,omitempty"`
	Text      string  `json:"text,omitempty"`
}

type Capability struct {
	ID                   string `json:"id"`
	Kind                 string `json:"kind"`
	Description          string `json:"description"`
	Input                string `json:"input,omitempty"`
	RequiresConfirmation bool   `json:"requiresConfirmation,omitempty"`
}

type Agent struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	DisplayName  string       `json:"displayName"`
	Description  string       `json:"description"`
	Capabilities []Capability `json:"capabilities"`
}

type Handed struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
}

type NamedRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Call struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"`
	Status     string   `json:"status"`
	Capability string   `json:"capability"`
	Caller     NamedRef `json:"caller"`
	Target     NamedRef `json:"target"`
	Input      string   `json:"input"`
	Result     *string  `json:"result"`
	Files      []string `json:"files"`
	Error      *string  `json:"error"`
	CreatedAt  int64    `json:"createdAt"`
	FinishedAt *int64   `json:"finishedAt"`
}

func (c Call) Terminal() bool {
	switch c.Status {
	case "done", "failed", "rejected", "cancelled", "expired":
		return true
	}
	return false
}

// ---- operations ----

func (c *Client) Recall(query, agent, kind string, limit int) ([]Hit, error) {
	q := url.Values{"q": {query}}
	if agent != "" {
		q.Set("agent", agent)
	}
	if kind != "" {
		q.Set("kind", kind)
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprint(limit))
	}
	var out struct {
		Hits []Hit `json:"hits"`
	}
	return out.Hits, c.getJSON("/recall", q, &out)
}

func (c *Client) History(limit int) ([]HistoryItem, error) {
	var out struct {
		Items []HistoryItem `json:"items"`
	}
	return out.Items, c.getJSON("/history", url.Values{"limit": {fmt.Sprint(limit)}}, &out)
}

func (c *Client) HistoryShow(id string) (HistoryItem, error) {
	var out HistoryItem
	return out, c.getJSON("/history/"+url.PathEscape(id), nil, &out)
}

func (c *Client) Memory() (shared, private string, err error) {
	var out struct {
		Shared  string `json:"shared"`
		Private string `json:"private"`
	}
	err = c.getJSON("/memory", nil, &out)
	return out.Shared, out.Private, err
}

func (c *Client) MemoryAdd(text string, private bool) error {
	scope := "shared"
	if private {
		scope = "private"
	}
	return c.postJSON("/memory", map[string]any{"text": text, "scope": scope}, nil)
}

func (c *Client) Agents() ([]Agent, error) {
	var out struct {
		Agents []Agent `json:"agents"`
	}
	return out.Agents, c.getJSON("/agents", nil, &out)
}

func (c *Client) Ask(agent, capability, question, idem string) (Call, error) {
	var out struct {
		Call Call `json:"call"`
	}
	return out.Call, c.postJSON("/ask", map[string]any{"agent": agent, "capability": capability, "question": question, "idempotencyKey": idem}, &out)
}

func (c *Client) Delegate(agent, capability, input, idem string) (Call, error) {
	var out struct {
		Call Call `json:"call"`
	}
	return out.Call, c.postJSON("/tasks", map[string]any{"agent": agent, "capability": capability, "input": input, "idempotencyKey": idem}, &out)
}

func (c *Client) GetCall(id string) (Call, error) {
	var out struct {
		Call Call `json:"call"`
	}
	return out.Call, c.getJSON("/calls/"+url.PathEscape(id), nil, &out)
}

func (c *Client) Cancel(id string) (Call, error) {
	var out struct {
		Call Call `json:"call"`
	}
	return out.Call, c.postJSON("/calls/"+url.PathEscape(id)+"/cancel", map[string]any{}, &out)
}

func (c *Client) File(agent, path string) ([]byte, error) {
	q := url.Values{"path": {path}}
	if agent != "" {
		q.Set("agent", agent)
	}
	return c.do(http.MethodGet, "/files", q, nil)
}

// CallFile downloads one file that came back with a call.
func (c *Client) CallFile(callID, name string) ([]byte, error) {
	return c.do(http.MethodGet, "/calls/"+url.PathEscape(callID)+"/files", url.Values{"name": {name}}, nil)
}

// Handoff passes one of this agent's saved files to the agent whose call this session answers.
func (c *Client) Handoff(path string) (Handed, error) {
	var out struct {
		Handed Handed `json:"handed"`
	}
	return out.Handed, c.postJSON("/handoff", map[string]any{"path": path}, &out)
}

// Wait polls a call until it settles or the deadline passes.
func (c *Client) Wait(id string, timeout, every time.Duration, sleep func(time.Duration)) (Call, error) {
	deadline := time.Now().Add(timeout)
	for {
		call, err := c.GetCall(id)
		if err != nil {
			return call, err
		}
		if call.Terminal() {
			return call, nil
		}
		if time.Now().After(deadline) {
			return call, errors.New("still running after the wait timeout; check later with `agentctl call " + id + "`")
		}
		sleep(every)
	}
}
