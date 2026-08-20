// Package client is a Go client + CLI entry point for the moss-server
// agent-facing corp-app API. It speaks the JSON contract the
// /api/v1/agent/corp-apps/* endpoints expose and knows nothing about
// moss internals: no env-var lookups, no os.Exit, no moss-specific help
// text (that lives in main.go).
package client

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

// DefaultPathPrefix is where moss-server mounts the agent-facing corp-app
// endpoints.
const DefaultPathPrefix = "/api/v1/agent/corp-apps"

// Client is an HTTP client for the corp-app API. Fields are exported so
// callers can swap the HTTP client (tests) or override the path prefix.
type Client struct {
	BaseURL    string
	Token      string
	PathPrefix string
	HTTP       *http.Client
}

// New returns a Client that sends Authorization: Bearer <token> on every
// request, with a trailing-slash-trimmed BaseURL and a 60s timeout (file
// uploads can be slower than wiki reads).
func New(baseURL, token string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		Token:      token,
		PathPrefix: DefaultPathPrefix,
		HTTP:       &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *Client) setAuth(req *http.Request) {
	req.Header.Set("Accept", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
}

func (c *Client) get(path string, out any) error {
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	c.setAuth(req)
	return c.do(req, out)
}

func (c *Client) post(path string, body any, out any) error {
	var buf io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequest(http.MethodPost, c.BaseURL+path, buf)
	if err != nil {
		return err
	}
	c.setAuth(req)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.do(req, out)
}

// postRaw POSTs raw bytes (used for file upload; the server reads the raw
// body and uploads it to the platform's media API).
func (c *Client) postRaw(path string, body []byte, out any) error {
	req, err := http.NewRequest(http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	c.setAuth(req)
	req.Header.Set("Content-Type", "application/octet-stream")
	return c.do(req, out)
}

func (c *Client) do(req *http.Request, out any) error {
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// ============================================================
// Response types — mirror server JSON
// ============================================================

type CorpApp struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Type         string   `json:"type"`
	Key          string   `json:"key"`
	Capabilities []string `json:"capabilities"`
}

type CorpAppsListResp struct {
	Apps []CorpApp `json:"apps"`
}

type SendResp struct {
	OK    bool   `json:"ok"`
	MsgID string `json:"msgId"`
}

type InboundMsg struct {
	ID         string `json:"id"`
	Seq        int64  `json:"seq"`
	From       string `json:"from"`
	Type       string `json:"type"`
	Text       string `json:"text"`
	MediaID    string `json:"mediaId"`
	FileName   string `json:"fileName"`
	ReceivedAt int64  `json:"receivedAt"`
}

type InboundResp struct {
	Messages   []InboundMsg `json:"messages"`
	NextCursor int64        `json:"nextCursor"`
}

// ============================================================
// Request methods
// ============================================================

// List returns the corp apps the bearer token's assistant may use.
func (c *Client) List() ([]CorpApp, error) {
	var resp CorpAppsListResp
	if err := c.get(c.PathPrefix, &resp); err != nil {
		return nil, err
	}
	return resp.Apps, nil
}

// ResolveByName resolves a single app by its user-assigned name.
func (c *Client) ResolveByName(name string) (*CorpApp, error) {
	if name == "" {
		return nil, errors.New("name is required")
	}
	q := url.Values{}
	q.Set("name", name)
	var app CorpApp
	if err := c.get(c.PathPrefix+"/resolve?"+q.Encode(), &app); err != nil {
		return nil, err
	}
	return &app, nil
}

// ResolveByKey resolves a single app by its per-type key (wecomapp:
// corpId:agentId).
func (c *Client) ResolveByKey(typ, key string) (*CorpApp, error) {
	if key == "" {
		return nil, errors.New("key is required")
	}
	q := url.Values{}
	q.Set("key", key)
	if typ != "" {
		q.Set("type", typ)
	}
	var app CorpApp
	if err := c.get(c.PathPrefix+"/resolve?"+q.Encode(), &app); err != nil {
		return nil, err
	}
	return &app, nil
}

// SendMessage sends a message via the app with the given id.
//
// format selects the message representation: "text" (plain, no styling) or
// "markdown" (provider-flavoured markdown — on WeCom this is what enables
// <font color="..."> colour spans). An empty format is omitted from the
// request body, letting the server apply its own default ("text").
func (c *Client) SendMessage(id, to, text, format string) (*SendResp, error) {
	var resp SendResp
	body := map[string]string{"to": to, "text": text}
	if format != "" {
		body["format"] = format
	}
	if err := c.post(c.PathPrefix+"/"+url.PathEscape(id)+"/messages", body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// SendFile uploads + sends a file via the app with the given id. The
// recipient and file name travel as query params; the bytes are the raw
// request body.
func (c *Client) SendFile(id, to, fileName string, bytes []byte) (*SendResp, error) {
	q := url.Values{}
	q.Set("to", to)
	q.Set("fileName", fileName)
	var resp SendResp
	if err := c.postRaw(c.PathPrefix+"/"+url.PathEscape(id)+"/files?"+q.Encode(), bytes, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// DownloadMedia fetches the raw bytes of an inbound media item by its
// provider media id. Returns the bytes and a best-effort filename taken
// from the server's X-Corp-App-Filename header (may be empty).
func (c *Client) DownloadMedia(id, mediaID string) ([]byte, string, error) {
	q := url.Values{}
	q.Set("mediaId", mediaID)
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+c.PathPrefix+"/"+url.PathEscape(id)+"/media?"+q.Encode(), nil)
	if err != nil {
		return nil, "", err
	}
	c.setAuth(req)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	fileName := ""
	if h := resp.Header.Get("X-Corp-App-Filename"); h != "" {
		if dec, derr := url.QueryUnescape(h); derr == nil {
			fileName = dec
		} else {
			fileName = h
		}
	}
	return raw, fileName, nil
}

// ApprovalListParams are the query parameters for ListApprovals. Start
// and End are Unix seconds (WeCom caps the window at 31 days). Cursor
// paginates (empty on the first page). Filters are opaque key/value
// pairs passed through to the provider (WeCom: template_id, creator,
// sp_status, record_type, department).
type ApprovalListParams struct {
	Start   int64
	End     int64
	Cursor  string
	Size    int64
	Filters []string // each "key:value"
}

// ListApprovals returns the raw provider response for the approval-id
// listing (WeCom getapprovalinfo: sp_no_list + new_next_cursor). The
// body is passed through undecoded so no provider fields are lost.
func (c *Client) ListApprovals(id string, p ApprovalListParams) (json.RawMessage, error) {
	q := url.Values{}
	q.Set("starttime", fmt.Sprintf("%d", p.Start))
	q.Set("endtime", fmt.Sprintf("%d", p.End))
	if p.Cursor != "" {
		q.Set("cursor", p.Cursor)
	}
	if p.Size > 0 {
		q.Set("size", fmt.Sprintf("%d", p.Size))
	}
	for _, f := range p.Filters {
		if f != "" {
			q.Add("filter", f)
		}
	}
	var raw json.RawMessage
	if err := c.get(c.PathPrefix+"/"+url.PathEscape(id)+"/approvals?"+q.Encode(), &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// GetApproval returns the raw provider detail for a single approval by
// its provider id (WeCom sp_no). Passed through undecoded.
func (c *Client) GetApproval(id, spNo string) (json.RawMessage, error) {
	if spNo == "" {
		return nil, errors.New("sp_no is required")
	}
	var raw json.RawMessage
	if err := c.get(c.PathPrefix+"/"+url.PathEscape(id)+"/approvals/"+url.PathEscape(spNo), &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// ============================================================
// Customer groups (客户群) + group broadcast (群发)
// ============================================================

// GroupMsgAttachment is one attachment on a 群发 task. Media must already be
// uploaded (see UploadMedia) — attachments reference a media id, not bytes.
type GroupMsgAttachment struct {
	MsgType string `json:"msgtype"`
	MediaID string `json:"mediaId,omitempty"`
}

// GroupMsgResp is the result of creating a 群发 task. FailList holds chat ids
// the provider rejected.
type GroupMsgResp struct {
	OK       bool     `json:"ok"`
	MsgID    string   `json:"msgId"`
	FailList []string `json:"failList"`
}

// UploadMediaResp is the result of an upload — a provider media id, valid for
// 3 days on WeCom.
type UploadMediaResp struct {
	MediaID string `json:"mediaId"`
}

// ListCustomerGroups returns the raw provider response for the customer-group
// listing (WeCom: group_chat_list + next_cursor), passed through undecoded.
//
// owner filters by GROUP OWNER, which is also how the provider scopes
// visibility: a group whose owner is outside the app's visible range is
// silently absent. Max 100 owner ids per call.
func (c *Client) ListCustomerGroups(id string, owner []string, cursor string, limit int64) (json.RawMessage, error) {
	q := url.Values{}
	if len(owner) > 0 {
		q.Set("owner", strings.Join(owner, ","))
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}
	var raw json.RawMessage
	path := c.PathPrefix + "/" + url.PathEscape(id) + "/customer-groups"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	if err := c.get(path, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// GetCustomerGroup returns one customer group's raw detail, including the
// member list (type 1 = internal staff, 2 = external contact).
func (c *Client) GetCustomerGroup(id, chatID string, needName bool) (json.RawMessage, error) {
	if chatID == "" {
		return nil, errors.New("chat-id is required")
	}
	q := url.Values{}
	if !needName {
		q.Set("needName", "0")
	}
	path := c.PathPrefix + "/" + url.PathEscape(id) + "/customer-groups/" + url.PathEscape(chatID)
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var raw json.RawMessage
	if err := c.get(path, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// SendGroupMessage creates a 群发 task targeting customer groups.
//
// This does NOT deliver the message: it creates a task that a human must
// confirm in the provider client, and API-created tasks additionally require
// administrator approval before the sender is notified. sender must be an
// internal staff userid who is already a member of the target group.
func (c *Client) SendGroupMessage(id string, chatIDs []string, sender, text string, attachments []GroupMsgAttachment) (*GroupMsgResp, error) {
	if len(chatIDs) == 0 {
		return nil, errors.New("at least one chat-id is required")
	}
	if sender == "" {
		return nil, errors.New("sender is required")
	}
	body := map[string]any{"chatIdList": chatIDs, "sender": sender}
	if text != "" {
		body["text"] = text
	}
	if len(attachments) > 0 {
		body["attachments"] = attachments
	}
	var resp GroupMsgResp
	if err := c.post(c.PathPrefix+"/"+url.PathEscape(id)+"/group-messages", body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// GroupMsgSendEntry is one target's outcome within a GroupMsgSummary.
type GroupMsgSendEntry struct {
	ChatID            string `json:"chatId"`
	Status            int    `json:"status"`
	StatusLabel       string `json:"statusLabel"`
	Delivered         bool   `json:"delivered"`
	BlockedByDailyCap bool   `json:"blockedByDailyCap"`
	SendTime          int64  `json:"sendTime,omitempty"`
}

// GroupMsgSummary is the reconciled view of what a 群发 actually delivered.
// Use this rather than task status: a task whose members show "sent" may have
// delivered to nobody, because a group accepts only one broadcast per day and
// same-day repeats are dropped after the human confirms them.
type GroupMsgSummary struct {
	MsgID             string              `json:"msgId"`
	Delivered         int                 `json:"delivered"`
	Pending           int                 `json:"pending"`
	Failed            int                 `json:"failed"`
	BlockedByDailyCap int                 `json:"blockedByDailyCap"`
	Entries           []GroupMsgSendEntry `json:"entries"`
}

// GroupMessageSummary reconciles a 群发 task into per-target delivery counts,
// classifying the daily-cap rejection explicitly.
func (c *Client) GroupMessageSummary(id, msgID, userID string) (*GroupMsgSummary, error) {
	if msgID == "" || userID == "" {
		return nil, errors.New("msgid and userid are required")
	}
	q := url.Values{}
	q.Set("userid", userID)
	var resp GroupMsgSummary
	if err := c.get(c.PathPrefix+"/"+url.PathEscape(id)+"/group-messages/"+url.PathEscape(msgID)+"/summary?"+q.Encode(), &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// GroupMessageResult returns per-target delivery status for a 群发 task.
// Provider status: 0=not sent 1=sent 2=failed (not a contact) 3=failed
// (target already received another broadcast — the daily per-group cap).
func (c *Client) GroupMessageResult(id, msgID, userID, cursor string) (json.RawMessage, error) {
	if msgID == "" || userID == "" {
		return nil, errors.New("msgid and userid are required")
	}
	q := url.Values{}
	q.Set("userid", userID)
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var raw json.RawMessage
	if err := c.get(c.PathPrefix+"/"+url.PathEscape(id)+"/group-messages/"+url.PathEscape(msgID)+"/result?"+q.Encode(), &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// GroupMessageTask returns per-member task status for a 群发.
// Provider status: 0=not sent 2=sent. A member showing "sent" only means they
// confirmed — use GroupMessageResult to learn whether the group received it.
func (c *Client) GroupMessageTask(id, msgID, cursor string) (json.RawMessage, error) {
	if msgID == "" {
		return nil, errors.New("msgid is required")
	}
	q := url.Values{}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	path := c.PathPrefix + "/" + url.PathEscape(id) + "/group-messages/" + url.PathEscape(msgID) + "/task"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var raw json.RawMessage
	if err := c.get(path, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// RemindGroupMessage re-triggers the confirmation prompt for a pending 群发.
// The provider allows at most 3 reminders per task per 24h.
func (c *Client) RemindGroupMessage(id, msgID string) (*SendResp, error) {
	if msgID == "" {
		return nil, errors.New("msgid is required")
	}
	var resp SendResp
	if err := c.post(c.PathPrefix+"/"+url.PathEscape(id)+"/group-messages/"+url.PathEscape(msgID)+"/remind", nil, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// UploadMedia uploads bytes and returns a provider media id for use as a
// group-message attachment. Unlike SendFile this does not send anything.
func (c *Client) UploadMedia(id, mediaType, fileName string, body []byte) (*UploadMediaResp, error) {
	q := url.Values{}
	q.Set("type", mediaType)
	q.Set("fileName", fileName)
	var resp UploadMediaResp
	if err := c.postRaw(c.PathPrefix+"/"+url.PathEscape(id)+"/media?"+q.Encode(), body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// Inbound polls buffered inbound messages with seq > since.
func (c *Client) Inbound(id string, since, limit int64) (*InboundResp, error) {
	q := url.Values{}
	q.Set("since", fmt.Sprintf("%d", since))
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}
	var resp InboundResp
	if err := c.get(c.PathPrefix+"/"+url.PathEscape(id)+"/inbound?"+q.Encode(), &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}
