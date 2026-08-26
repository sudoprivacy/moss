package client

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// queueStub captures the request body so tests can assert on request shaping,
// and replies with a canned response.
func queueStub(t *testing.T, reply string, captured *map[string]any) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/resolve") {
			_, _ = io.WriteString(w, `{"id":"app1","name":"x","type":"wecomapp"}`)
			return
		}
		if captured != nil {
			_ = json.NewDecoder(r.Body).Decode(captured)
		}
		_, _ = io.WriteString(w, reply)
	})
}

func TestQueueEnqueueSendsMetaAndKeys(t *testing.T) {
	var got map[string]any
	c, srv := newTestClient(queueStub(t, `{"ok":true,"duplicate":false,"entry":{"entryId":"q_1"}}`, &got))
	defer srv.Close()

	meta := map[string]any{"type": "日常追货提醒", "customer_id": "C1024"}
	r, err := c.QueueEnqueue("app1", "wr_a", meta, "k1", "2026-08-26T10:00:00+08:00")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Entry.EntryID != "q_1" || r.Duplicate {
		t.Errorf("unexpected response: %+v", r)
	}
	if got["action"] != "enqueue" || got["chatId"] != "wr_a" {
		t.Errorf("body wrong: %+v", got)
	}
	if got["idempotencyKey"] != "k1" || got["expiresAt"] != "2026-08-26T10:00:00+08:00" {
		t.Errorf("keys not forwarded: %+v", got)
	}
	m, _ := got["meta"].(map[string]any)
	if m["type"] != "日常追货提醒" {
		t.Errorf("meta not forwarded: %+v", got["meta"])
	}
}

// A re-run must not queue the same reminder twice.
func TestQueueEnqueueReportsDuplicate(t *testing.T) {
	c, srv := newTestClient(queueStub(t, `{"ok":true,"duplicate":true,"entry":{"entryId":"q_1"}}`, nil))
	defer srv.Close()

	r, err := c.QueueEnqueue("app1", "wr_a", map[string]any{"type": "x"}, "k1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !r.Duplicate {
		t.Error("want duplicate=true")
	}
}

func TestQueueEnqueueRequiresChatAndMeta(t *testing.T) {
	c := New("http://unused", "t")
	if _, err := c.QueueEnqueue("app1", "", map[string]any{"a": 1}, "", ""); err == nil {
		t.Error("want error for empty chat id")
	}
	if _, err := c.QueueEnqueue("app1", "wr_a", nil, "", ""); err == nil {
		t.Error("want error for nil meta")
	}
}

// Truncation must be visible: a caller seeing 2 entries needs to know 7 more
// were eligible, or it will conclude the run is complete.
func TestQueueNextReportsTruncation(t *testing.T) {
	c, srv := newTestClient(queueStub(t, `{
	  "entries":[{"entryId":"q_1","chatId":"wr_a"},{"entryId":"q_2","chatId":"wr_b"}],
	  "skipped":[{"chatId":"wr_c","reason":"already_sent_today","lastSentDate":"2026-08-25"},
	             {"chatId":"wr_d","reason":"pending_exists","blockingEntryId":"q_0"}],
	  "totalEligible":9,"hasMore":true}`, nil))
	defer srv.Close()

	r, err := c.QueueNext("app1", "", 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !r.HasMore || r.TotalEligible != 9 {
		t.Errorf("truncation must be visible: %+v", r)
	}
	if len(r.Skipped) != 2 {
		t.Fatalf("want 2 skipped, got %d", len(r.Skipped))
	}
	if r.Skipped[0].Reason != "already_sent_today" || r.Skipped[1].BlockingEntryID != "q_0" {
		t.Errorf("skip reasons not surfaced: %+v", r.Skipped)
	}
}

// The loser of a claim race must be told, not silently allowed to send.
func TestQueueClaimReportsSlotTaken(t *testing.T) {
	c, srv := newTestClient(queueStub(t, `{"ok":false,"reason":"slot_taken"}`, nil))
	defer srv.Close()

	r, err := c.QueueClaim("app1", "wr_a", "q_1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.OK || r.Reason != "slot_taken" {
		t.Errorf("want refusal, got %+v", r)
	}
}

func TestQueueMarkSentRequiresMsgidAndSender(t *testing.T) {
	c := New("http://unused", "t")
	if _, err := c.QueueMarkSent("app1", "wr_a", "q_1", "", "linqinhui"); err == nil {
		t.Error("want error for empty msgid")
	}
	// sender is required because send results are scoped per sender at reconcile
	if _, err := c.QueueMarkSent("app1", "wr_a", "q_1", "msg_1", ""); err == nil {
		t.Error("want error for empty sender")
	}
}

func TestQueueMarkSentForwardsSender(t *testing.T) {
	var got map[string]any
	c, srv := newTestClient(queueStub(t, `{"ok":true}`, &got))
	defer srv.Close()

	if _, err := c.QueueMarkSent("app1", "wr_a", "q_1", "msg_1", "linqinhui"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got["sender"] != "linqinhui" || got["msgid"] != "msg_1" {
		t.Errorf("body wrong: %+v", got)
	}
}

// reap is time-only; cancel carries a business reason. Both may withdraw the
// task at WeCom, which is opt-in.
func TestQueueCancelForwardsReasonAndWecomFlag(t *testing.T) {
	var got map[string]any
	c, srv := newTestClient(queueStub(t, `{"ok":true,"wecomCancelled":true}`, &got))
	defer srv.Close()

	r, err := c.QueueCancel("app1", "wr_a", "q_1", "排期已取消", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !r.WecomCancelled {
		t.Error("want wecomCancelled=true")
	}
	if got["reason"] != "排期已取消" || got["cancelWecom"] != true {
		t.Errorf("body wrong: %+v", got)
	}
}

func TestQueueReapSurfacesUncancelledWeComTask(t *testing.T) {
	c, srv := newTestClient(queueStub(t, `{"reaped":[
	  {"chatId":"wr_a","entryId":"q_1","msgid":"msg_1","expiresAt":"2026-08-25T10:00:00+08:00","wecomCancelled":false}]}`, nil))
	defer srv.Close()

	r, err := c.QueueReap("app1", "", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(r.Reaped) != 1 || r.Reaped[0].WecomCancelled {
		t.Fatalf("unexpected: %+v", r.Reaped)
	}
	// A reaped entry still live at WeCom could be confirmed days later and eat
	// that day's quota — the formatter must warn about it.
	var buf strings.Builder
	FormatQueueReap(&buf, r)
	if !strings.Contains(buf.String(), "still pending at WeCom") {
		t.Errorf("expected a warning:\n%s", buf.String())
	}
}

// status 3 = confirmed by a human, delivered to nobody. The single most
// misleading outcome, so it must be called out explicitly.
func TestFormatQueueReconcileCallsOutDailyCap(t *testing.T) {
	var buf strings.Builder
	FormatQueueReconcile(&buf, &QueueReconcileResp{Reconciled: []ReconcileOutcome{
		{EntryID: "q_1", ChatID: "wr_a", SendStatus: 1, State: "delivered"},
		{EntryID: "q_2", ChatID: "wr_b", SendStatus: 3, State: "failed", Reason: "daily_cap"},
	}})
	out := buf.String()
	if !strings.Contains(out, "delivered=1") || !strings.Contains(out, "failed=1") {
		t.Errorf("counts missing:\n%s", out)
	}
	if !strings.Contains(out, "nothing delivered") {
		t.Errorf("status 3 must be explained:\n%s", out)
	}
}

// Held-back groups are the only signal that a customer got nothing today.
func TestFormatQueueNextAlwaysShowsSkipped(t *testing.T) {
	var buf strings.Builder
	FormatQueueNext(&buf, &QueueNextResp{
		Entries:       []QueueEntry{{EntryID: "q_1", ChatID: "wr_a", Meta: map[string]any{"type": "日常追货提醒"}}},
		Skipped:       []SkippedGroup{{ChatID: "wr_b", Reason: "already_sent_today", LastSentDate: "2026-08-25"}},
		TotalEligible: 1,
	})
	out := buf.String()
	if !strings.Contains(out, "skipped:") || !strings.Contains(out, "wr_b") {
		t.Errorf("skipped groups must be printed:\n%s", out)
	}
	if !strings.Contains(out, "日常追货提醒") {
		t.Errorf("meta type should summarise the entry:\n%s", out)
	}
}

func TestParseMetaJSON(t *testing.T) {
	if _, err := ParseMetaJSON(""); err == nil {
		t.Error("want error for empty meta")
	}
	if _, err := ParseMetaJSON("{not json"); err == nil {
		t.Error("want error for malformed meta")
	}
	m, err := ParseMetaJSON(`{"type":"x","n":1}`)
	if err != nil || m["type"] != "x" {
		t.Errorf("unexpected: %v %+v", err, m)
	}
}
