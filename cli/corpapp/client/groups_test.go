package client

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTestClient points a Client at a stub server so request shaping can be
// asserted without touching the network.
func newTestClient(h http.Handler) (*Client, *httptest.Server) {
	srv := httptest.NewServer(h)
	c := New(srv.URL, "test-token")
	return c, srv
}

// Real-shape response captured live from groupchat/get for
// 锐锢x数牍-采购组-日常追货AI对接交流群: two internal staff (type 1, real
// userids) and one external contact (type 2, opaque wo_ id).
const sampleGroupDetail = `{
  "errcode": 0, "errmsg": "ok",
  "group_chat": {
    "chat_id": "wr_l7aCgAARDx8B2PbMyxeU4J6vWdWsQ",
    "name": "锐锢x数牍-采购组-日常追货AI对接交流群",
    "owner": "linqinhui",
    "member_list": [
      {"userid":"wangjingjing","type":1,"name":"王晶晶"},
      {"userid":"wo_l7aCgAAGJKbg-X0rVavEkTEVwKXcg","type":2,"name":"朱宇翔"},
      {"userid":"linqinhui","type":1,"name":"林秦辉"}
    ]
  }
}`

func TestGetCustomerGroupPassesThroughRaw(t *testing.T) {
	var gotPath string
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		_, _ = io.WriteString(w, sampleGroupDetail)
	}))
	defer srv.Close()

	raw, err := c.GetCustomerGroup("app1", "wr_l7aCgAARDx8B2PbMyxeU4J6vWdWsQ", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// needName defaults on, so no needName param should be sent.
	if strings.Contains(gotPath, "needName") {
		t.Errorf("needName should be omitted when true, got %q", gotPath)
	}
	if !strings.Contains(gotPath, "customer-groups/wr_l7aCgAARDx8B2PbMyxeU4J6vWdWsQ") {
		t.Errorf("chat id not in path: %q", gotPath)
	}
	// Raw passthrough: member types must survive undecoded.
	var parsed struct {
		GroupChat struct {
			MemberList []struct {
				UserID string `json:"userid"`
				Type   int    `json:"type"`
			} `json:"member_list"`
		} `json:"group_chat"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("raw not valid json: %v", err)
	}
	if n := len(parsed.GroupChat.MemberList); n != 3 {
		t.Fatalf("want 3 members, got %d", n)
	}
	if parsed.GroupChat.MemberList[1].Type != 2 {
		t.Errorf("external member should be type 2, got %d", parsed.GroupChat.MemberList[1].Type)
	}
}

func TestGetCustomerGroupNoName(t *testing.T) {
	var gotPath string
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		_, _ = io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	if _, err := c.GetCustomerGroup("app1", "wr_x", false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(gotPath, "needName=0") {
		t.Errorf("want needName=0 in %q", gotPath)
	}
}

func TestListCustomerGroupsOwnerFilter(t *testing.T) {
	var gotPath string
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		_, _ = io.WriteString(w, `{"group_chat_list":[]}`)
	}))
	defer srv.Close()

	if _, err := c.ListCustomerGroups("app1", []string{"linqinhui", "xueyan"}, "CUR", 500); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"owner=linqinhui%2Cxueyan", "cursor=CUR", "limit=500"} {
		if !strings.Contains(gotPath, want) {
			t.Errorf("want %q in %q", want, gotPath)
		}
	}
}

func TestListCustomerGroupsOmitsEmptyParams(t *testing.T) {
	var gotPath string
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		_, _ = io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	if _, err := c.ListCustomerGroups("app1", nil, "", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(gotPath, "?") {
		t.Errorf("no query params expected, got %q", gotPath)
	}
}

func TestSendGroupMessageBuildsBody(t *testing.T) {
	var gotBody map[string]any
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = io.WriteString(w, `{"ok":true,"msgId":"msg_x","failList":["wr_bad"]}`)
	}))
	defer srv.Close()

	resp, err := c.SendGroupMessage("app1", []string{"wr_a", "wr_b"}, "linqinhui", "周报",
		[]GroupMsgAttachment{{MsgType: "file", MediaID: "M1"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.MsgID != "msg_x" || !resp.OK {
		t.Errorf("unexpected response: %+v", resp)
	}
	if len(resp.FailList) != 1 || resp.FailList[0] != "wr_bad" {
		t.Errorf("failList not surfaced: %+v", resp.FailList)
	}
	if gotBody["sender"] != "linqinhui" || gotBody["text"] != "周报" {
		t.Errorf("body wrong: %+v", gotBody)
	}
	if ids, ok := gotBody["chatIdList"].([]any); !ok || len(ids) != 2 {
		t.Errorf("chatIdList wrong: %+v", gotBody["chatIdList"])
	}
}

// Text is optional when attachments carry the payload, so an empty --text must
// not be sent as an empty string (the provider rejects a blank text block).
func TestSendGroupMessageOmitsEmptyText(t *testing.T) {
	var gotBody map[string]any
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	if _, err := c.SendGroupMessage("app1", []string{"wr_a"}, "linqinhui", "",
		[]GroupMsgAttachment{{MsgType: "file", MediaID: "M1"}}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, present := gotBody["text"]; present {
		t.Errorf("empty text should be omitted, got %+v", gotBody)
	}
}

func TestSendGroupMessageValidatesLocally(t *testing.T) {
	c := New("http://unused", "t")
	if _, err := c.SendGroupMessage("app1", nil, "linqinhui", "hi", nil); err == nil {
		t.Error("want error for empty chat id list")
	}
	if _, err := c.SendGroupMessage("app1", []string{"wr_a"}, "", "hi", nil); err == nil {
		t.Error("want error for empty sender")
	}
}

func TestGroupMessageResultRequiresIDs(t *testing.T) {
	c := New("http://unused", "t")
	if _, err := c.GroupMessageResult("app1", "", "linqinhui", ""); err == nil {
		t.Error("want error for empty msgid")
	}
	if _, err := c.GroupMessageResult("app1", "msg_x", "", ""); err == nil {
		t.Error("want error for empty userid")
	}
}

func TestGroupMessageResultSendsUserID(t *testing.T) {
	var gotPath string
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		// status 3 = target already received another broadcast (daily cap).
		_, _ = io.WriteString(w, `{"send_list":[{"chat_id":"wr_a","status":3}]}`)
	}))
	defer srv.Close()

	raw, err := c.GroupMessageResult("app1", "msg_x", "linqinhui", "CUR")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"userid=linqinhui", "cursor=CUR", "group-messages/msg_x/result"} {
		if !strings.Contains(gotPath, want) {
			t.Errorf("want %q in %q", want, gotPath)
		}
	}
	if !strings.Contains(string(raw), `"status":3`) {
		t.Errorf("status not passed through: %s", raw)
	}
}

func TestRemindGroupMessage(t *testing.T) {
	var gotMethod, gotPath string
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	resp, err := c.RemindGroupMessage("app1", "msg_x")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.OK {
		t.Error("want ok")
	}
	if gotMethod != http.MethodPost {
		t.Errorf("want POST, got %s", gotMethod)
	}
	if !strings.HasSuffix(gotPath, "/group-messages/msg_x/remind") {
		t.Errorf("unexpected path %q", gotPath)
	}
}

func TestUploadMediaSendsTypeAndBytes(t *testing.T) {
	var gotPath string
	var gotBody []byte
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		gotBody, _ = io.ReadAll(r.Body)
		_, _ = io.WriteString(w, `{"mediaId":"WWME_X"}`)
	}))
	defer srv.Close()

	resp, err := c.UploadMedia("app1", "file", "report.pdf", []byte("PDFDATA"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.MediaID != "WWME_X" {
		t.Errorf("want media id, got %q", resp.MediaID)
	}
	if !strings.Contains(gotPath, "type=file") || !strings.Contains(gotPath, "fileName=report.pdf") {
		t.Errorf("params missing in %q", gotPath)
	}
	if string(gotBody) != "PDFDATA" {
		t.Errorf("raw body not forwarded, got %q", gotBody)
	}
}

// Mirrors the real production incident: 测试6 delivered (status 1), then 测试7
// sent 105 seconds later to the same group was dropped (status 3) despite the
// sender having confirmed it.
func TestGroupMessageSummaryFlagsDailyCap(t *testing.T) {
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{
		  "msgId":"msg_x","delivered":1,"pending":0,"failed":1,"blockedByDailyCap":1,
		  "entries":[
		    {"chatId":"wr_a","status":1,"statusLabel":"已发送","delivered":true,"blockedByDailyCap":false},
		    {"chatId":"wr_b","status":3,"statusLabel":"发送失败（今日已收到其他群发）","delivered":false,"blockedByDailyCap":true}
		  ]}`)
	}))
	defer srv.Close()

	sum, err := c.GroupMessageSummary("app1", "msg_x", "linqinhui")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sum.Delivered != 1 || sum.BlockedByDailyCap != 1 {
		t.Errorf("counts wrong: %+v", sum)
	}
	if !sum.Entries[1].BlockedByDailyCap {
		t.Error("status 3 entry should be flagged as daily-cap blocked")
	}
}

func TestGroupMessageSummaryRequiresIDs(t *testing.T) {
	c := New("http://unused", "t")
	if _, err := c.GroupMessageSummary("app1", "", "linqinhui"); err == nil {
		t.Error("want error for empty msgid")
	}
	if _, err := c.GroupMessageSummary("app1", "msg_x", ""); err == nil {
		t.Error("want error for empty userid")
	}
}

// The daily-cap warning must be prominent — it is the only signal a human gets
// that a confirmed send delivered nothing.
func TestFormatGroupSummaryWarnsOnDailyCap(t *testing.T) {
	var buf strings.Builder
	FormatGroupSummary(&buf, &GroupMsgSummary{
		MsgID: "msg_x", Delivered: 0, Failed: 1, BlockedByDailyCap: 1,
		Entries: []GroupMsgSendEntry{{ChatID: "wr_b", Status: 3, StatusLabel: "发送失败（今日已收到其他群发）", BlockedByDailyCap: true}},
	})
	out := buf.String()
	if !strings.Contains(out, "WARNING") || !strings.Contains(out, "received nothing") {
		t.Errorf("expected a prominent warning, got:\n%s", out)
	}
}

func TestFormatGroupSummaryQuietWhenAllDelivered(t *testing.T) {
	var buf strings.Builder
	FormatGroupSummary(&buf, &GroupMsgSummary{
		MsgID: "msg_x", Delivered: 2,
		Entries: []GroupMsgSendEntry{
			{ChatID: "wr_a", Status: 1, StatusLabel: "已发送", Delivered: true},
			{ChatID: "wr_b", Status: 1, StatusLabel: "已发送", Delivered: true},
		},
	})
	if strings.Contains(buf.String(), "WARNING") {
		t.Errorf("no warning expected when all delivered:\n%s", buf.String())
	}
}
