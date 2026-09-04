package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Verifies the mention list reaches the server body under the key the server
// route reads. A silently-dropped mention is indistinguishable from success
// (WeCom answers 0 ok either way), so this is worth pinning.
func TestSendInternalGroupForwardsMentions(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{"ok":true,"msgId":"m1"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "tok")
	if _, err := c.SendInternalGroup("a1", "chat1", "hi", "text", "", "", []string{"zhuyx", "test1"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	ml, ok := got["mentionedList"].([]any)
	if !ok || len(ml) != 2 || ml[0] != "zhuyx" {
		t.Fatalf("mentionedList not forwarded: %#v", got)
	}
	// A file-only send must not carry mentions — they ride on the text message.
	got = nil
	if _, err := c.SendInternalGroup("a1", "chat1", "", "", "mid", "file", nil); err != nil {
		t.Fatalf("send file: %v", err)
	}
	if _, present := got["mentionedList"]; present {
		t.Fatalf("file send should not carry mentions: %#v", got)
	}
}
