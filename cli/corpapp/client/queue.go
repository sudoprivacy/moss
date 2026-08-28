package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
)

// The group broadcast queue. WeCom spends a group's daily quota when a human
// CONFIRMS a task, not when the API creates one, and confirmation can land
// hours later — so intent has to be remembered between runs. The server holds
// the state; this is a thin typed wrapper over the one queue endpoint.

// QueueEntry mirrors the server's entry shape.
type QueueEntry struct {
	EntryID    string         `json:"entryId"`
	ChatID     string         `json:"chatId"`
	State      string         `json:"state"`
	Meta       map[string]any `json:"meta"`
	ExpiresAt  string         `json:"expiresAt,omitempty"`
	EnqueuedAt string         `json:"enqueuedAt,omitempty"`
	Sender     string         `json:"sender,omitempty"`
	MsgID      string         `json:"msgid,omitempty"`
	Reason     string         `json:"reason,omitempty"`
}

// SkippedGroup explains why a group was passed over by next. Surfaced so a
// caller never silently drops a customer.
type SkippedGroup struct {
	ChatID          string `json:"chatId"`
	Reason          string `json:"reason"`
	BlockingEntryID string `json:"blockingEntryId,omitempty"`
	BlockingMsgID   string `json:"blockingMsgid,omitempty"`
	LastSentDate    string `json:"lastSentDate,omitempty"`
}

// QueueNextResp always carries TotalEligible/HasMore so a --limit truncation is
// never mistaken for an empty queue.
type QueueNextResp struct {
	Entries       []QueueEntry   `json:"entries"`
	Skipped       []SkippedGroup `json:"skipped"`
	TotalEligible int            `json:"totalEligible"`
	HasMore       bool           `json:"hasMore"`
	// Entries next settled against WeCom before deciding eligibility. next
	// reconciles first because a `sent` entry stays `sent` until someone asks
	// the provider, so an unsettled queue reports a group as blocked long after
	// its message landed.
	Reconciled []ReconcileOutcome `json:"reconciled,omitempty"`
}

type QueueEnqueueResp struct {
	OK        bool       `json:"ok"`
	Duplicate bool       `json:"duplicate"`
	Entry     QueueEntry `json:"entry"`
}

type QueueActionResp struct {
	OK             bool   `json:"ok"`
	Reason         string `json:"reason,omitempty"`
	State          string `json:"state,omitempty"`
	WecomCancelled bool   `json:"wecomCancelled,omitempty"`
}

type ReapedEntry struct {
	ChatID         string `json:"chatId"`
	EntryID        string `json:"entryId"`
	MsgID          string `json:"msgid,omitempty"`
	ExpiresAt      string `json:"expiresAt,omitempty"`
	WecomCancelled bool   `json:"wecomCancelled"`
}

type QueueReapResp struct {
	Reaped []ReapedEntry `json:"reaped"`
}

type ReconcileOutcome struct {
	ChatID     string `json:"chatId"`
	EntryID    string `json:"entryId"`
	MsgID      string `json:"msgid"`
	Sender     string `json:"sender"`
	SendStatus int    `json:"sendStatus"`
	State      string `json:"state"`
	Reason     string `json:"reason,omitempty"`
}

type QueueReconcileResp struct {
	Reconciled []ReconcileOutcome `json:"reconciled"`
}

type QueueListResp struct {
	Entries []QueueEntry `json:"entries"`
}

func (c *Client) queuePost(id string, body map[string]any, out any) error {
	return c.post(c.PathPrefix+"/"+url.PathEscape(id)+"/queue", body, out)
}

// QueueEnqueue records a message INTENT. Content is deliberately not stored —
// it must be composed from fresh data at send time, potentially hours later.
// An idempotency key makes a re-run safe.
func (c *Client) QueueEnqueue(id, chatID string, meta map[string]any, idemKey, expiresAt string) (*QueueEnqueueResp, error) {
	if chatID == "" || meta == nil {
		return nil, errors.New("chat-id and meta are required")
	}
	body := map[string]any{"action": "enqueue", "chatId": chatID, "meta": meta}
	if idemKey != "" {
		body["idempotencyKey"] = idemKey
	}
	if expiresAt != "" {
		body["expiresAt"] = expiresAt
	}
	var resp QueueEnqueueResp
	if err := c.queuePost(id, body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// QueueNext returns at most one sendable entry per group.
func (c *Client) QueueNext(id, chatID string, limit int64) (*QueueNextResp, error) {
	body := map[string]any{"action": "next"}
	if chatID != "" {
		body["chatId"] = chatID
	}
	if limit > 0 {
		body["limit"] = limit
	}
	var resp QueueNextResp
	if err := c.queuePost(id, body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// QueueClaim takes the group's slot for today BEFORE content is composed, so a
// concurrent agent cannot also send to that group.
func (c *Client) QueueClaim(id, chatID, entryID string) (*QueueActionResp, error) {
	return c.queueSimple(id, "claim", chatID, entryID, nil)
}

// QueueRelease hands the slot back when a claimed entry could not be sent.
func (c *Client) QueueRelease(id, chatID, entryID, reason string) (*QueueActionResp, error) {
	return c.queueSimple(id, "release", chatID, entryID, map[string]any{"reason": reason})
}

// QueueMarkSent binds the msgid and records the sender the task was assigned
// to; reconcile needs it because send results are scoped per sender.
func (c *Client) QueueMarkSent(id, chatID, entryID, msgid, sender string) (*QueueActionResp, error) {
	if msgid == "" || sender == "" {
		return nil, errors.New("msgid and sender are required")
	}
	return c.queueSimple(id, "mark-sent", chatID, entryID, map[string]any{"msgid": msgid, "sender": sender})
}

// QueueCancel cancels an entry for a BUSINESS reason. Expiry-based removal is
// reap's job; this one is for "the schedule moved", "the customer replied".
func (c *Client) QueueCancel(id, chatID, entryID, reason string, cancelWecom bool) (*QueueActionResp, error) {
	return c.queueSimple(id, "cancel", chatID, entryID,
		map[string]any{"reason": reason, "cancelWecom": cancelWecom})
}

func (c *Client) queueSimple(id, action, chatID, entryID string, extra map[string]any) (*QueueActionResp, error) {
	if chatID == "" || entryID == "" {
		return nil, errors.New("chat-id and entry-id are required")
	}
	body := map[string]any{"action": action, "chatId": chatID, "entryId": entryID}
	for k, v := range extra {
		body[k] = v
	}
	var resp QueueActionResp
	if err := c.queuePost(id, body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// QueueReap cancels entries past their own expiresAt. Judged ONLY on time —
// business-driven cancellation goes through QueueCancel.
func (c *Client) QueueReap(id, chatID string, cancelWecom bool) (*QueueReapResp, error) {
	body := map[string]any{"action": "reap", "cancelWecom": cancelWecom}
	if chatID != "" {
		body["chatId"] = chatID
	}
	var resp QueueReapResp
	if err := c.queuePost(id, body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// QueueReconcile settles sent entries against what WeCom actually delivered.
func (c *Client) QueueReconcile(id, chatID string) (*QueueReconcileResp, error) {
	body := map[string]any{"action": "reconcile"}
	if chatID != "" {
		body["chatId"] = chatID
	}
	var resp QueueReconcileResp
	if err := c.queuePost(id, body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// QueueList is raw inspection, and how a caller finds its own entries to apply
// business rules to (filter client-side on meta).
func (c *Client) QueueList(id, chatID, state string) (*QueueListResp, error) {
	body := map[string]any{"action": "list"}
	if chatID != "" {
		body["chatId"] = chatID
	}
	if state != "" {
		body["state"] = state
	}
	var resp QueueListResp
	if err := c.queuePost(id, body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// ParseMetaJSON validates --meta so a malformed blob fails at the CLI boundary
// rather than being stored and surfacing much later.
func ParseMetaJSON(s string) (map[string]any, error) {
	if s == "" {
		return nil, errors.New("--meta is required")
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, fmt.Errorf("--meta is not valid JSON: %w", err)
	}
	return m, nil
}
