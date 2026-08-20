package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// The provider allows each customer group to RECEIVE one broadcast per day.
// It never reports remaining quota, and it does not reject an over-quota task
// at creation: the task is accepted, a human confirms it, and only the
// send-result exposes the drop as status 3. So the only way to guard is to
// reconstruct recent history and refuse locally before a human is involved.

// CapWindow selects how "already sent today" is bounded.
type CapWindow string

const (
	// CapWindowCalendar treats the quota as resetting at local midnight.
	// Matches the provider's own wording ("一条/天"), which implies a calendar
	// boundary in its operating timezone.
	CapWindowCalendar CapWindow = "calendar"
	// CapWindowRolling treats the quota as a rolling 24h lookback. Stricter
	// near midnight: a 23:50 send still blocks 00:10 the next calendar day.
	CapWindowRolling CapWindow = "rolling24h"
)

// ParseCapWindow validates a --cap-window value.
func ParseCapWindow(v string) (CapWindow, error) {
	switch CapWindow(v) {
	case CapWindowCalendar:
		return CapWindowCalendar, nil
	case CapWindowRolling:
		return CapWindowRolling, nil
	default:
		return "", fmt.Errorf("invalid --cap-window %q: must be %q or %q", v, CapWindowCalendar, CapWindowRolling)
	}
}

// ProviderTZ is the timezone the provider operates in. The quota resets on the
// provider's clock, not the caller's, so calendar-window checks are evaluated
// here rather than in local time.
const ProviderTZ = "Asia/Shanghai"

func providerLocation() *time.Location {
	loc, err := time.LoadLocation(ProviderTZ)
	if err != nil {
		// Fall back to a fixed +08:00 when the host lacks tzdata, so the check
		// stays correct rather than silently degrading to the local zone.
		return time.FixedZone("CST", 8*60*60)
	}
	return loc
}

// capWindowStart returns the earliest instant still inside the quota window.
func capWindowStart(now time.Time, w CapWindow) time.Time {
	switch w {
	case CapWindowRolling:
		return now.Add(-24 * time.Hour)
	default:
		n := now.In(providerLocation())
		return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, n.Location())
	}
}

// DailyCapViolation reports groups that already used today's quota. It
// implements error so callers can return it directly, and carries structure so
// automation can react without parsing the message.
type DailyCapViolation struct {
	Window     CapWindow
	WindowFrom time.Time
	// Blocked maps chat id -> when it last received a broadcast.
	Blocked map[string]time.Time
}

func (e *DailyCapViolation) Error() string {
	ids := make([]string, 0, len(e.Blocked))
	for id := range e.Blocked {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	var b strings.Builder
	fmt.Fprintf(&b, "daily cap: %d of the target group(s) already received a broadcast", len(ids))
	if e.Window == CapWindowRolling {
		fmt.Fprintf(&b, " in the last 24h")
	} else {
		fmt.Fprintf(&b, " today (%s, %s)", e.WindowFrom.Format("2006-01-02"), ProviderTZ)
	}
	b.WriteString("\n")
	for _, id := range ids {
		fmt.Fprintf(&b, "  %s  last sent %s\n", id, e.Blocked[id].In(providerLocation()).Format("2006-01-02 15:04:05"))
	}
	b.WriteString("\nSending anyway would not fail loudly: the provider accepts the task, an\n")
	b.WriteString("admin approves it, the sender taps confirm — and the group still receives\n")
	b.WriteString("nothing (send result status 3). Retry after the quota resets, or pass\n")
	b.WriteString("--skip-capped to drop these targets and send to the rest.")
	return b.String()
}

// BlockedIDs returns the offending chat ids, sorted.
func (e *DailyCapViolation) BlockedIDs() []string {
	ids := make([]string, 0, len(e.Blocked))
	for id := range e.Blocked {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// groupMsgListEntry is the subset of a 群发 record we need.
type groupMsgListEntry struct {
	MsgID      string `json:"msgid"`
	CreateTime int64  `json:"create_time"`
}

// ListGroupMsgs returns raw 群发 records in a window (unix seconds).
func (c *Client) ListGroupMsgs(id string, start, end int64, creator, cursor string, limit int64) (json.RawMessage, error) {
	if start <= 0 || end <= 0 {
		return nil, errors.New("start and end (unix seconds) are required")
	}
	q := url.Values{}
	q.Set("start", fmt.Sprintf("%d", start))
	q.Set("end", fmt.Sprintf("%d", end))
	if creator != "" {
		q.Set("creator", creator)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", limit))
	}
	var raw json.RawMessage
	if err := c.get(c.PathPrefix+"/"+url.PathEscape(id)+"/group-messages?"+q.Encode(), &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// RecentlyBroadcastGroups returns chat ids that already received a broadcast
// inside the quota window, mapped to when.
//
// It walks recent 群发 tasks and follows each into its send result, counting a
// group only when the provider confirms delivery (status 1). Tasks that were
// themselves dropped, or are still awaiting confirmation, do not consume the
// target's quota and so must not block a new send.
//
// sender scopes the send-result lookup; the provider requires a userid there.
func (c *Client) RecentlyBroadcastGroups(appID, sender string, w CapWindow, now time.Time) (map[string]time.Time, error) {
	if sender == "" {
		return nil, errors.New("sender is required to check the daily cap")
	}
	from := capWindowStart(now, w)
	raw, err := c.ListGroupMsgs(appID, from.Unix(), now.Unix(), "", "", 100)
	if err != nil {
		return nil, fmt.Errorf("list recent broadcasts: %w", err)
	}
	var listResp struct {
		GroupMsgList []groupMsgListEntry `json:"group_msg_list"`
	}
	if err := json.Unmarshal(raw, &listResp); err != nil {
		return nil, fmt.Errorf("decode broadcast list: %w", err)
	}

	seen := map[string]time.Time{}
	for _, m := range listResp.GroupMsgList {
		if m.MsgID == "" {
			continue
		}
		sum, err := c.GroupMessageSummary(appID, m.MsgID, sender)
		if err != nil {
			// A task belonging to another sender is not visible to us; that is
			// expected, not fatal. Skip it rather than failing the whole check.
			continue
		}
		for _, e := range sum.Entries {
			if !e.Delivered || e.ChatID == "" {
				continue
			}
			at := time.Unix(e.SendTime, 0)
			if e.SendTime == 0 {
				at = time.Unix(m.CreateTime, 0)
			}
			if at.Before(from) {
				continue
			}
			if prev, ok := seen[e.ChatID]; !ok || at.After(prev) {
				seen[e.ChatID] = at
			}
		}
	}
	return seen, nil
}

// CheckDailyCap returns a *DailyCapViolation when any target already used its
// quota. A nil error means every target is clear.
func (c *Client) CheckDailyCap(appID, sender string, chatIDs []string, w CapWindow, now time.Time) error {
	seen, err := c.RecentlyBroadcastGroups(appID, sender, w, now)
	if err != nil {
		return err
	}
	blocked := map[string]time.Time{}
	for _, id := range chatIDs {
		if at, ok := seen[id]; ok {
			blocked[id] = at
		}
	}
	if len(blocked) == 0 {
		return nil
	}
	return &DailyCapViolation{Window: w, WindowFrom: capWindowStart(now, w), Blocked: blocked}
}
