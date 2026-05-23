package client

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// FormatWikiList writes the human-readable wiki table (header + rows, or the
// empty-list line) to w. Output is byte-identical to what the wiki CLI emits
// for `wiki list`.
func FormatWikiList(w io.Writer, wikis []WikiSummary) {
	if len(wikis) == 0 {
		fmt.Fprintln(w, "(no wikis available to this assistant)")
		return
	}
	fmt.Fprintf(w, "%-36s  %-30s  %s\n", "ID", "NAME", "DESCRIPTION")
	for _, wk := range wikis {
		desc := wk.Description
		if len(desc) > 80 {
			desc = desc[:77] + "..."
		}
		fmt.Fprintf(w, "%-36s  %-30s  %s\n", wk.ID, truncate(wk.Name, 30), desc)
	}
}

// FormatWikiListJSON writes pretty-printed JSON of the wiki list to w,
// matching `wiki list --json`.
func FormatWikiListJSON(w io.Writer, wikis []WikiSummary) error {
	b, err := json.MarshalIndent(wikis, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(w, string(b))
	return nil
}

// FormatSearchMatches writes search results (or "(no matches)") to w in the
// `file:line: text` format used by `wiki search`.
func FormatSearchMatches(w io.Writer, matches []SearchMatch) {
	if len(matches) == 0 {
		fmt.Fprintln(w, "(no matches)")
		return
	}
	for _, m := range matches {
		fmt.Fprintf(w, "%s:%d: %s\n", m.File, m.LineNo, strings.TrimRight(m.Line, "\r"))
	}
}

// FormatMetadata writes the multi-line metadata block to w, matching
// `wiki metadata`.
func FormatMetadata(w io.Writer, m *MetadataResp) {
	fmt.Fprintf(w, "Wiki ID:           %s\n", m.WikiID)
	fmt.Fprintf(w, "Name:              %s\n", m.Name)
	if m.Description != "" {
		fmt.Fprintf(w, "Description:       %s\n", m.Description)
	}
	fmt.Fprintf(w, "Build status:      %s\n", m.BuildStatus)
	if m.LastBuiltAt != nil {
		fmt.Fprintf(w, "Last built at:     %s\n", time.UnixMilli(*m.LastBuiltAt).Format(time.RFC3339))
	} else {
		fmt.Fprintln(w, "Last built at:     never")
	}
	fmt.Fprintf(w, "Source documents:  %d\n", m.SourceDocumentCount)
	fmt.Fprintf(w, "Chunks:            %d\n", m.ChunkCount)
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
