package client

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func shanghai(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return loc
}

func TestParseCapWindow(t *testing.T) {
	for _, v := range []string{"calendar", "rolling24h"} {
		if _, err := ParseCapWindow(v); err != nil {
			t.Errorf("%q should be valid: %v", v, err)
		}
	}
	if _, err := ParseCapWindow("daily"); err == nil {
		t.Error("want error for unknown window")
	}
}

// The two windows genuinely differ near midnight — this is the whole reason
// the flag exists.
func TestCapWindowStartDiffersAcrossMidnight(t *testing.T) {
	loc := shanghai(t)
	now := time.Date(2026, 8, 20, 0, 30, 0, 0, loc) // 00:30 provider time

	cal := capWindowStart(now, CapWindowCalendar)
	if cal.Hour() != 0 || cal.Minute() != 0 || cal.Day() != 20 {
		t.Errorf("calendar window should start at local midnight, got %s", cal)
	}
	roll := capWindowStart(now, CapWindowRolling)
	if roll.Day() != 19 || roll.Hour() != 0 || roll.Minute() != 30 {
		t.Errorf("rolling window should look back 24h, got %s", roll)
	}
	// A 23:50 send yesterday is outside the calendar window but inside rolling.
	prev := time.Date(2026, 8, 19, 23, 50, 0, 0, loc)
	if prev.Before(cal) == false {
		t.Error("23:50 yesterday should be outside today's calendar window")
	}
	if prev.Before(roll) {
		t.Error("23:50 yesterday should be inside the rolling 24h window")
	}
}

// capStub serves a broadcast list plus a per-msgid summary.
func capStub(t *testing.T, msgs []map[string]any, summaries map[string]string) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/resolve"):
			_, _ = io.WriteString(w, `{"id":"app1","name":"x","type":"wecomapp"}`)
		case strings.Contains(r.URL.Path, "/summary"):
			parts := strings.Split(r.URL.Path, "/")
			msgID := parts[len(parts)-2]
			if body, ok := summaries[msgID]; ok {
				_, _ = io.WriteString(w, body)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		case strings.HasSuffix(r.URL.Path, "/group-messages"):
			b, _ := json.Marshal(map[string]any{"group_msg_list": msgs})
			_, _ = w.Write(b)
		default:
			_, _ = io.WriteString(w, `{}`)
		}
	})
}

func TestCheckDailyCapBlocksDeliveredTarget(t *testing.T) {
	now := time.Now()
	sent := now.Add(-2 * time.Hour).Unix()
	c, srv := newTestClient(capStub(t,
		[]map[string]any{{"msgid": "msg_a", "create_time": sent}},
		map[string]string{"msg_a": `{"msgId":"msg_a","entries":[
			{"chatId":"wr_blocked","status":1,"delivered":true,"sendTime":` + itoa(sent) + `}]}`},
	))
	defer srv.Close()

	err := c.CheckDailyCap("app1", "linqinhui", []string{"wr_blocked", "wr_free"}, CapWindowCalendar, now)
	var v *DailyCapViolation
	if !errors.As(err, &v) {
		t.Fatalf("want DailyCapViolation, got %v", err)
	}
	if ids := v.BlockedIDs(); len(ids) != 1 || ids[0] != "wr_blocked" {
		t.Errorf("wrong blocked set: %v", ids)
	}
	if !strings.Contains(v.Error(), "status 3") {
		t.Errorf("error should explain the silent-failure mode:\n%s", v.Error())
	}
}

// A task that was itself dropped (status 3) never consumed the target's quota,
// so it must not block a retry.
func TestCheckDailyCapIgnoresUndeliveredTasks(t *testing.T) {
	now := time.Now()
	sent := now.Add(-time.Hour).Unix()
	c, srv := newTestClient(capStub(t,
		[]map[string]any{{"msgid": "msg_a", "create_time": sent}},
		map[string]string{"msg_a": `{"msgId":"msg_a","entries":[
			{"chatId":"wr_x","status":3,"delivered":false,"blockedByDailyCap":true},
			{"chatId":"wr_y","status":0,"delivered":false}]}`},
	))
	defer srv.Close()

	if err := c.CheckDailyCap("app1", "linqinhui", []string{"wr_x", "wr_y"}, CapWindowCalendar, now); err != nil {
		t.Fatalf("undelivered targets must not block: %v", err)
	}
}

func TestCheckDailyCapPassesWhenNoHistory(t *testing.T) {
	c, srv := newTestClient(capStub(t, nil, nil))
	defer srv.Close()
	if err := c.CheckDailyCap("app1", "linqinhui", []string{"wr_a"}, CapWindowCalendar, time.Now()); err != nil {
		t.Errorf("want clear, got %v", err)
	}
}

func TestCheckDailyCapRequiresSender(t *testing.T) {
	c := New("http://unused", "t")
	if _, err := c.RecentlyBroadcastGroups("app1", "", CapWindowCalendar, time.Now()); err == nil {
		t.Error("want error when sender is empty")
	}
}

// A send delivered before the window opened is stale and must not block.
func TestCheckDailyCapIgnoresOutsideWindow(t *testing.T) {
	now := time.Now()
	old := now.Add(-72 * time.Hour).Unix()
	c, srv := newTestClient(capStub(t,
		[]map[string]any{{"msgid": "msg_old", "create_time": old}},
		map[string]string{"msg_old": `{"msgId":"msg_old","entries":[
			{"chatId":"wr_a","status":1,"delivered":true,"sendTime":` + itoa(old) + `}]}`},
	))
	defer srv.Close()

	if err := c.CheckDailyCap("app1", "linqinhui", []string{"wr_a"}, CapWindowRolling, now); err != nil {
		t.Errorf("a 3-day-old send must not block: %v", err)
	}
}

func TestDailyCapViolationMessageNamesWindow(t *testing.T) {
	loc := shanghai(t)
	now := time.Date(2026, 8, 20, 10, 0, 0, 0, loc)
	v := &DailyCapViolation{
		Window: CapWindowRolling, WindowFrom: capWindowStart(now, CapWindowRolling),
		Blocked: map[string]time.Time{"wr_a": now.Add(-time.Hour)},
	}
	if !strings.Contains(v.Error(), "last 24h") {
		t.Errorf("rolling window should be named:\n%s", v.Error())
	}
	cal := &DailyCapViolation{
		Window: CapWindowCalendar, WindowFrom: capWindowStart(now, CapWindowCalendar),
		Blocked: map[string]time.Time{"wr_a": now.Add(-time.Hour)},
	}
	if !strings.Contains(cal.Error(), "Asia/Shanghai") {
		t.Errorf("calendar window should name the provider timezone:\n%s", cal.Error())
	}
}

func itoa(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestListGroupMsgsRequiresWindow(t *testing.T) {
	c := New("http://unused", "t")
	if _, err := c.ListGroupMsgs("app1", 0, 0, "", "", 0); err == nil {
		t.Error("want error when start/end are missing")
	}
}

func TestListGroupMsgsSendsParams(t *testing.T) {
	var gotPath string
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		_, _ = io.WriteString(w, `{"group_msg_list":[]}`)
	}))
	defer srv.Close()

	if _, err := c.ListGroupMsgs("app1", 1000, 2000, "linqinhui", "CUR", 50); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"start=1000", "end=2000", "creator=linqinhui", "cursor=CUR", "limit=50"} {
		if !strings.Contains(gotPath, want) {
			t.Errorf("want %q in %q", want, gotPath)
		}
	}
}
