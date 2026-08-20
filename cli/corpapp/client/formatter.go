package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// FormatApps writes the human-readable corp-app table to w.
func FormatApps(w io.Writer, apps []CorpApp) {
	if len(apps) == 0 {
		fmt.Fprintln(w, "(no corp apps available to this assistant)")
		return
	}
	fmt.Fprintf(w, "%-24s  %-12s  %-28s  %s\n", "NAME", "TYPE", "KEY", "CAPABILITIES")
	for _, a := range apps {
		fmt.Fprintf(w, "%-24s  %-12s  %-28s  %s\n",
			truncate(a.Name, 24), a.Type, truncate(a.Key, 28), strings.Join(a.Capabilities, ","))
	}
}

// FormatAppsJSON writes pretty-printed JSON of the corp-app list.
func FormatAppsJSON(w io.Writer, apps []CorpApp) error {
	b, err := json.MarshalIndent(apps, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(w, string(b))
	return nil
}

// FormatApp writes a single resolved corp app as a key-value block.
func FormatApp(w io.Writer, a *CorpApp) {
	fmt.Fprintf(w, "ID:            %s\n", a.ID)
	fmt.Fprintf(w, "Name:          %s\n", a.Name)
	fmt.Fprintf(w, "Type:          %s\n", a.Type)
	fmt.Fprintf(w, "Key:           %s\n", a.Key)
	fmt.Fprintf(w, "Capabilities:  %s\n", strings.Join(a.Capabilities, ", "))
}

// FormatAppJSON writes a single resolved corp app as JSON.
func FormatAppJSON(w io.Writer, a *CorpApp) error {
	b, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(w, string(b))
	return nil
}

// FormatSend writes the outcome of a send / send-file call.
func FormatSend(w io.Writer, r *SendResp) {
	if r.OK {
		if r.MsgID != "" {
			fmt.Fprintf(w, "sent (msgId=%s)\n", r.MsgID)
		} else {
			fmt.Fprintln(w, "sent")
		}
		return
	}
	fmt.Fprintln(w, "send failed")
}

// FormatInbound writes inbound messages (or "(no new messages)") plus the
// next cursor to use on the following poll.
// FormatGroupMsg renders the result of creating a 群发 task. The task is
// pending human confirmation, so this reports "task created", never "sent".
func FormatGroupMsg(w io.Writer, r *GroupMsgResp) {
	status := "created"
	if !r.OK {
		status = "failed"
	}
	fmt.Fprintf(w, "group message task %s", status)
	if r.MsgID != "" {
		fmt.Fprintf(w, "  msgid=%s", r.MsgID)
	}
	fmt.Fprintln(w)
	if len(r.FailList) > 0 {
		fmt.Fprintf(w, "rejected chat ids: %s\n", strings.Join(r.FailList, ", "))
	}
	fmt.Fprintln(w, "NOTE: awaiting confirmation in the provider client before delivery.")
}

// FormatGroupSummary renders reconciled delivery counts, calling out targets
// dropped by the one-broadcast-per-group-per-day cap since that failure is
// otherwise invisible — the sender sees a normal "sent".
func FormatGroupSummary(w io.Writer, s *GroupMsgSummary) {
	fmt.Fprintf(w, "msgid %s\n", s.MsgID)
	fmt.Fprintf(w, "delivered=%d  pending=%d  failed=%d\n", s.Delivered, s.Pending, s.Failed)
	if s.BlockedByDailyCap > 0 {
		fmt.Fprintf(w, "\nWARNING: %d target(s) received nothing — already got a broadcast today.\n", s.BlockedByDailyCap)
		fmt.Fprintln(w, "Each group accepts one broadcast per day; retry tomorrow.")
	}
	if len(s.Entries) > 0 {
		fmt.Fprintln(w, "\nCHAT ID                              STATUS")
		for _, e := range s.Entries {
			fmt.Fprintf(w, "%-36s %s\n", truncate(e.ChatID, 36), e.StatusLabel)
		}
	}
}

func FormatGroupSummaryJSON(w io.Writer, s *GroupMsgSummary) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

func FormatInbound(w io.Writer, r *InboundResp) {
	if len(r.Messages) == 0 {
		fmt.Fprintln(w, "(no new messages)")
		fmt.Fprintf(w, "next cursor: %d\n", r.NextCursor)
		return
	}
	for _, m := range r.Messages {
		ts := time.UnixMilli(m.ReceivedAt).Format(time.RFC3339)
		switch m.Type {
		case "text":
			fmt.Fprintf(w, "[%d] %s  from %s: %s\n", m.Seq, ts, m.From, m.Text)
		case "file":
			fmt.Fprintf(w, "[%d] %s  from %s: <file %s mediaId=%s>\n", m.Seq, ts, m.From, m.FileName, m.MediaID)
		case "image":
			fmt.Fprintf(w, "[%d] %s  from %s: <image mediaId=%s>\n", m.Seq, ts, m.From, m.MediaID)
		default:
			fmt.Fprintf(w, "[%d] %s  from %s: <%s>\n", m.Seq, ts, m.From, m.Type)
		}
	}
	fmt.Fprintf(w, "next cursor: %d\n", r.NextCursor)
}

// FormatInboundJSON writes the inbound response as JSON.
func FormatInboundJSON(w io.Writer, r *InboundResp) error {
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(w, string(b))
	return nil
}

// FormatRawJSON pretty-prints a raw provider JSON response. Approval
// responses are passed through undecoded, so we re-indent for readability
// but never drop or rename fields.
func FormatRawJSON(w io.Writer, raw json.RawMessage) error {
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		// Not valid JSON (shouldn't happen) — print as-is.
		fmt.Fprintln(w, string(raw))
		return nil
	}
	fmt.Fprintln(w, buf.String())
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return "."
	}
	return s[:n-1] + "…"
}
