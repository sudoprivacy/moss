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

// DefaultCapLookback is how far back InspectQuota looks for tasks. It is NOT the
// quota window: a task created before the window can still spend the window's
// quota, because the quota goes when a human confirms, not when the task is
// created — and the broadcast list filters by creation time. Listing only from
// the window start (today 00:00) missed both a task created yesterday and
// confirmed this morning, and a task created yesterday still awaiting
// confirmation.
//
// 72h covers the queue's default entry TTL (72h when 保留时长 is empty), after
// which reap withdraws unconfirmed tasks. A task older than this is one whose
// withdrawal failed or that was created outside the queue; widen --cap-lookback
// for those (the provider caps the list at one month).
const DefaultCapLookback = 72 * time.Hour

// MaxCapLookback is the provider's limit on a broadcast listing's time range.
const MaxCapLookback = 31 * 24 * time.Hour

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
//
// Tasks are listed over `lookback`, not over the window (see DefaultCapLookback).
// To keep that affordable, the task list is read first: a task whose every
// assignee confirmed before the window cannot have spent this window's quota,
// so its send result is not fetched. Tasks created inside the window are always
// read in full, exactly as before.
func (c *Client) InspectQuota(appID, sender string, w CapWindow, lookback time.Duration, now time.Time) (*QuotaState, error) {
	if sender == "" {
		return nil, errors.New("sender is required to check the daily cap")
	}
	from := capWindowStart(now, w)
	listFrom := now.Add(-lookback)
	if lookback <= 0 || from.Before(listFrom) {
		// Never list less than the window itself.
		listFrom = from
	}
	msgs, err := c.listGroupMsgsAll(appID, listFrom.Unix(), now.Unix())
	if err != nil {
		return nil, fmt.Errorf("list recent broadcasts: %w", err)
	}

	state := &QuotaState{Delivered: map[string]time.Time{}, Pending: map[string]string{}}
	for _, m := range msgs {
		if m.MsgID == "" {
			continue
		}

		// Is anyone still sitting on this task? get_groupmsg_task needs no
		// userid, so this sees every assignee regardless of `sender`.
		task, terr := c.readGroupMsgTask(appID, m.MsgID)
		unconfirmed := terr == nil && task.unconfirmed

		// An older task that everyone confirmed before the window began spent an
		// earlier day's quota (or none); it says nothing about this window.
		if terr == nil && !unconfirmed && m.CreateTime < from.Unix() &&
			!task.lastSent.IsZero() && task.lastSent.Before(from) {
			continue
		}

		// One send-result read per task serves both checks below. It used to be
		// read twice (once inside targetsOf, once here), and each read is a
		// provider call; with a day's worth of tasks that doubling is what
		// tipped busy send loops into 45009.
		sum, sumErr := c.GroupMessageSummary(appID, m.MsgID, sender)

		if unconfirmed && sumErr == nil {
			for _, e := range sum.Entries {
				if e.ChatID == "" {
					continue
				}
				if _, already := state.Pending[e.ChatID]; !already {
					state.Pending[e.ChatID] = m.MsgID
				}
			}
		}

		if sumErr != nil {
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

// maxBroadcastPages bounds the listing walk: 100 per page is far beyond a
// few days' broadcasts, and a cursor that never ends must not spin forever.
const maxBroadcastPages = 20

// listGroupMsgsAll reads every 群发 record in the window, following the cursor.
// Reading only the first page would miss tasks past the 100th — and with them
// any quota those tasks already spent, which is exactly what the guard exists
// to see.
func (c *Client) listGroupMsgsAll(appID string, start, end int64) ([]groupMsgListEntry, error) {
	var all []groupMsgListEntry
	cursor := ""
	for page := 0; page < maxBroadcastPages; page++ {
		raw, err := c.ListGroupMsgs(appID, start, end, "", cursor, 100)
		if err != nil {
			return nil, err
		}
		var resp struct {
			GroupMsgList []groupMsgListEntry `json:"group_msg_list"`
			NextCursor   string              `json:"next_cursor"`
		}
		if err := json.Unmarshal(raw, &resp); err != nil {
			return nil, fmt.Errorf("decode broadcast list: %w", err)
		}
		all = append(all, resp.GroupMsgList...)
		if resp.NextCursor == "" || resp.NextCursor == cursor {
			return all, nil
		}
		cursor = resp.NextCursor
	}
	return nil, fmt.Errorf("broadcast list did not end within %d pages", maxBroadcastPages)
}

// groupMsgTaskState is what get_groupmsg_task says about a 群发 as a whole.
type groupMsgTaskState struct {
	// unconfirmed: some assignee is still at status 0 (未发送).
	unconfirmed bool
	// lastSent: the latest send_time among assignees who confirmed. Zero when
	// nobody has, or when the provider omitted it.
	lastSent time.Time
}

// readGroupMsgTask reads every page of a task's assignee list. A cursor that
// does not end is reported as unconfirmed, so the caller falls back to the
// full check instead of skipping the task.
func (c *Client) readGroupMsgTask(appID, msgID string) (groupMsgTaskState, error) {
	var st groupMsgTaskState
	cursor := ""
	for page := 0; page < maxBroadcastPages; page++ {
		raw, err := c.GroupMessageTask(appID, msgID, cursor)
		if err != nil {
			return st, err
		}
		var resp struct {
			TaskList []struct {
				Status   int   `json:"status"`
				SendTime int64 `json:"send_time"`
			} `json:"task_list"`
			NextCursor string `json:"next_cursor"`
		}
		if err := json.Unmarshal(raw, &resp); err != nil {
			return st, err
		}
		for _, t := range resp.TaskList {
			if t.Status == 0 {
				st.unconfirmed = true
				continue
			}
			if t.SendTime > 0 {
				if at := time.Unix(t.SendTime, 0); at.After(st.lastSent) {
					st.lastSent = at
				}
			}
		}
		if resp.NextCursor == "" || resp.NextCursor == cursor {
			return st, nil
		}
		cursor = resp.NextCursor
	}
	st.unconfirmed = true
	return st, nil
}

// CheckDailyCap returns a *DailyCapViolation when any target already used its
// quota. A nil error means every target is clear. lookback is how far back to
// look for tasks (DefaultCapLookback when zero); see DefaultCapLookback.
func (c *Client) CheckDailyCap(appID, sender string, chatIDs []string, w CapWindow, lookback time.Duration, now time.Time) error {
	if lookback == 0 {
		lookback = DefaultCapLookback
	}
	state, err := c.InspectQuota(appID, sender, w, lookback, now)
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
