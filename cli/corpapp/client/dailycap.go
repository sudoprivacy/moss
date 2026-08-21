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

// DailyCapViolation reports groups whose daily quota is already spoken for. It
// implements error so callers can return it directly, and carries structure so
// automation can react without parsing the message.
//
// Two distinct reasons, because they need different operator responses:
//   - Delivered: the group already RECEIVED a broadcast in this window. Nothing
//     to do but wait for the reset.
//   - Pending: a task for this group is awaiting confirmation. It has not spent
//     the quota yet, but confirming it will — so submitting another now queues a
//     second task that is guaranteed to settle as status 3. The operator can
//     cancel the stale task instead of waiting.
type DailyCapViolation struct {
	Window     CapWindow
	WindowFrom time.Time
	// Delivered maps chat id -> when it received a broadcast in this window.
	Delivered map[string]time.Time
	// Pending maps chat id -> the msgid of an unconfirmed task targeting it.
	Pending map[string]string
}

func (e *DailyCapViolation) Error() string {
	var b strings.Builder
	window := "today (" + e.WindowFrom.Format("2006-01-02") + ", " + ProviderTZ + ")"
	if e.Window == CapWindowRolling {
		window = "in the last 24h"
	}
	fmt.Fprintf(&b, "daily cap: %d target group(s) cannot receive a broadcast %s\n", len(e.BlockedIDs()), window)

	if len(e.Delivered) > 0 {
		b.WriteString("\nalready received a broadcast:\n")
		for _, id := range sortedKeys(e.Delivered) {
			fmt.Fprintf(&b, "  %s  last sent %s\n", id,
				e.Delivered[id].In(providerLocation()).Format("2006-01-02 15:04:05"))
		}
	}
	if len(e.Pending) > 0 {
		b.WriteString("\nawaiting confirmation (will consume the quota once confirmed):\n")
		for _, id := range sortedKeysStr(e.Pending) {
			fmt.Fprintf(&b, "  %s  msgid %s\n", id, e.Pending[id])
		}
	}

	b.WriteString("\nSending anyway would not fail loudly: the provider accepts the task, an\n")
	b.WriteString("admin approves it, the sender taps confirm — and the group still receives\n")
	b.WriteString("nothing (send result status 3).\n")
	if len(e.Pending) > 0 {
		b.WriteString("For the pending ones, cancel the outstanding task to free the slot, or\n")
		b.WriteString("wait for it to be confirmed.\n")
	}
	b.WriteString("Pass --skip-capped to drop these targets and send to the rest.")
	return b.String()
}

func sortedKeys(m map[string]time.Time) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedKeysStr(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// BlockedIDs returns every blocked chat id, from either reason, sorted and
// deduplicated. This is what --skip-capped drops.
func (e *DailyCapViolation) BlockedIDs() []string {
	set := make(map[string]struct{}, len(e.Delivered)+len(e.Pending))
	for id := range e.Delivered {
		set[id] = struct{}{}
	}
	for id := range e.Pending {
		set[id] = struct{}{}
	}
	ids := make([]string, 0, len(set))
	for id := range set {
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

// QuotaState is what the provider currently says about each group's daily slot.
type QuotaState struct {
	// Delivered: group -> when it received a broadcast inside the window. The
	// quota is already spent.
	Delivered map[string]time.Time
	// Pending: group -> msgid of an unconfirmed task targeting it. The quota is
	// not spent yet, but is claimed: confirming that task consumes it.
	Pending map[string]string
}

// InspectQuota reconstructs each target group's quota state from the provider.
//
// Two things block a group, and they are found differently:
//
//   - DELIVERED (status 1): walk recent tasks into their send results. Only
//     counted when the delivery timestamp falls inside the window; anything
//     older is stale. Statuses 2 and 3 never delivered, so they consume nothing
//     and are ignored. Cancelled tasks surface as an error on the summary call
//     and are skipped.
//
//   - PENDING (task status 0): an unconfirmed task. Deliberately NOT filtered by
//     the window — a pending task carries no send time, and whenever it is
//     eventually confirmed it consumes the quota of THAT day. A task created
//     just before midnight would otherwise slip through and silently eat the
//     new day's slot.
//
// Pending detection is also broader than delivered detection: get_groupmsg_task
// takes only a msgid, so it reveals every assignee, while send results require a
// userid and therefore only cover `sender`. A colleague's pending task is
// visible; their delivered one is not.
func (c *Client) InspectQuota(appID, sender string, w CapWindow, now time.Time) (*QuotaState, error) {
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

	state := &QuotaState{Delivered: map[string]time.Time{}, Pending: map[string]string{}}
	for _, m := range listResp.GroupMsgList {
		if m.MsgID == "" {
			continue
		}

		// Is anyone still sitting on this task? get_groupmsg_task needs no
		// userid, so this sees every assignee regardless of `sender`.
		unconfirmed, terr := c.hasUnconfirmedTask(appID, m.MsgID)
		if terr == nil && unconfirmed {
			for _, id := range c.targetsOf(appID, m.MsgID, sender) {
				if _, already := state.Pending[id]; !already {
					state.Pending[id] = m.MsgID
				}
			}
		}

		sum, err := c.GroupMessageSummary(appID, m.MsgID, sender)
		if err != nil {
			// Not visible to this sender, or cancelled (41093). Either way the
			// delivered set gains nothing; skip rather than fail the check.
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
			if prev, ok := state.Delivered[e.ChatID]; !ok || at.After(prev) {
				state.Delivered[e.ChatID] = at
			}
		}
	}
	return state, nil
}

// hasUnconfirmedTask reports whether any assignee still has this task at
// status 0 (未发送).
func (c *Client) hasUnconfirmedTask(appID, msgID string) (bool, error) {
	raw, err := c.GroupMessageTask(appID, msgID, "")
	if err != nil {
		return false, err
	}
	var resp struct {
		TaskList []struct {
			Status int `json:"status"`
		} `json:"task_list"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return false, err
	}
	for _, t := range resp.TaskList {
		if t.Status == 0 {
			return true, nil
		}
	}
	return false, nil
}

// targetsOf lists the chat ids a task addresses. The send result enumerates
// every target regardless of its status, which is what we need for a task that
// has not been confirmed yet.
func (c *Client) targetsOf(appID, msgID, sender string) []string {
	sum, err := c.GroupMessageSummary(appID, msgID, sender)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(sum.Entries))
	for _, e := range sum.Entries {
		if e.ChatID != "" {
			out = append(out, e.ChatID)
		}
	}
	return out
}

// CheckDailyCap returns a *DailyCapViolation when any target already used its
// quota. A nil error means every target is clear.
func (c *Client) CheckDailyCap(appID, sender string, chatIDs []string, w CapWindow, now time.Time) error {
	state, err := c.InspectQuota(appID, sender, w, now)
	if err != nil {
		return err
	}
	delivered := map[string]time.Time{}
	pending := map[string]string{}
	for _, id := range chatIDs {
		if at, ok := state.Delivered[id]; ok {
			delivered[id] = at
			continue // already spent; the pending reason would be redundant
		}
		if msgID, ok := state.Pending[id]; ok {
			pending[id] = msgID
		}
	}
	if len(delivered) == 0 && len(pending) == 0 {
		return nil
	}
	return &DailyCapViolation{
		Window:     w,
		WindowFrom: capWindowStart(now, w),
		Delivered:  delivered,
		Pending:    pending,
	}
}
