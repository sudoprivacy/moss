package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeServer(t *testing.T) (*httptest.Server, *[]string) {
	t.Helper()
	var seen []string
	polls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agent/agentify/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		seen = append(seen, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/agent/agentify/recall":
			json.NewEncoder(w).Encode(map[string]any{"hits": []map[string]any{{"id": "doc-123456789", "kind": "summary", "title": "第44周返厂", "snippet": "厨卫五金 128 件", "createdAt": 1793600000000}, {"id": "doc-987654321", "kind": "input", "title": "10月发车.xlsx（输入）", "path": "/agent-home/o/a/inputs/s1/10月发车.xlsx", "snippet": "第3行：日期=2026-10-03", "createdAt": 1793600000000}}})
		case r.URL.Path == "/api/v1/agent/agentify/ask" && r.Method == "POST":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["agent"] != "售后返厂助手" || body["capability"] != "return-stats" || body["question"] != "上周 返厂" {
				w.WriteHeader(400)
				return
			}
			w.WriteHeader(202)
			json.NewEncoder(w).Encode(map[string]any{"call": map[string]any{"id": "c1", "kind": "ask", "status": "running", "target": map[string]string{"name": "售后返厂助手"}}})
		case r.URL.Path == "/api/v1/agent/agentify/calls/c1":
			polls++
			status := "running"
			var result any
			if polls >= 2 {
				status, result = "done", "厨卫五金最多"
			}
			json.NewEncoder(w).Encode(map[string]any{"call": map[string]any{"id": "c1", "kind": "ask", "status": status, "result": result, "capability": "return-stats", "target": map[string]string{"name": "售后返厂助手"}, "files": []string{"/agent-home/o/a/artifacts/s/answer.md"}}})
		case r.URL.Path == "/api/v1/agent/agentify/tasks":
			w.WriteHeader(403)
			json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "not_allowed", "message": "售后返厂助手 does not accept calls"}})
		case r.URL.Path == "/api/v1/agent/agentify/files":
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write([]byte("report-bytes"))
		case r.URL.Path == "/api/v1/agent/agentify/memory" && r.Method == "POST":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["scope"] != "private" {
				w.WriteHeader(400)
				return
			}
			w.Write([]byte(`{"ok":true}`))
		default:
			w.WriteHeader(404)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &seen
}

func run(t *testing.T, srv *httptest.Server, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Run(args, NewClient(srv.URL, "tok"), &out, &errOut, func(time.Duration) {})
	return code, out.String(), errOut.String()
}

func TestRecallPrintsHits(t *testing.T) {
	srv, seen := fakeServer(t)
	code, out, _ := run(t, srv, "recall", "返厂 品类", "--limit", "3")
	if code != 0 || !strings.Contains(out, "厨卫五金 128 件") || !strings.Contains(out, "(id doc-1234)") ||
		!strings.Contains(out, "file: /agent-home/o/a/inputs/s1/10月发车.xlsx") || strings.Count(out, "file: ") != 1 {
		t.Fatalf("code=%d out=%q", code, out)
	}
	if !strings.Contains((*seen)[0], "limit=3") || !strings.Contains((*seen)[0], "q=%E8%BF%94") {
		t.Fatalf("query not forwarded: %v", *seen)
	}
}

func TestAskWaitsForTheAnswer(t *testing.T) {
	srv, _ := fakeServer(t)
	code, out, errOut := run(t, srv, "ask", "--agent", "售后返厂助手", "--capability", "return-stats", "上周", "返厂")
	if code != 0 {
		t.Fatalf("code=%d err=%s", code, errOut)
	}
	if !strings.Contains(out, "status=done") || !strings.Contains(out, "厨卫五金最多") || !strings.Contains(out, "answer.md") {
		t.Fatalf("out=%q", out)
	}
}

func TestServerErrorsAreReported(t *testing.T) {
	srv, _ := fakeServer(t)
	code, _, errOut := run(t, srv, "delegate", "--agent", "售后返厂助手", "--capability", "x", "做事")
	if code != 2 || !strings.Contains(errOut, "not_allowed") {
		t.Fatalf("code=%d err=%q", code, errOut)
	}
}

func TestFilesGetWritesTheFile(t *testing.T) {
	srv, _ := fakeServer(t)
	dir := t.TempDir()
	dest := filepath.Join(dir, "r.md")
	code, out, errOut := run(t, srv, "files", "get", "--agent", "售后返厂助手", "/agent-home/o/a/artifacts/s/r.md", "--out", dest)
	if code != 0 {
		t.Fatalf("code=%d err=%s", code, errOut)
	}
	data, _ := os.ReadFile(dest)
	if string(data) != "report-bytes" || !strings.Contains(out, "saved") {
		t.Fatalf("data=%q out=%q", data, out)
	}
}

func TestMemoryAddPrivateFlagAfterText(t *testing.T) {
	srv, _ := fakeServer(t)
	code, out, errOut := run(t, srv, "memory", "add", "张三喜欢表格", "--private")
	if code != 0 || !strings.Contains(out, "remembered") {
		t.Fatalf("code=%d out=%q err=%q", code, out, errOut)
	}
}

func TestUsageErrors(t *testing.T) {
	srv, _ := fakeServer(t)
	if code, _, _ := run(t, srv, "ask", "--agent", "x"); code != 1 {
		t.Fatalf("missing capability should fail with 1, got %d", code)
	}
	if code, _, _ := run(t, srv, "bogus"); code != 1 {
		t.Fatalf("unknown command should fail")
	}
	if code, out, _ := run(t, srv, "--help"); code != 0 || !strings.Contains(out, "agentctl ask") {
		t.Fatalf("help")
	}
}
