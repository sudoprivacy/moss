package client

import (
	"encoding/json"
	"testing"
)

// Real-shape payload captured live from getapprovaldetail for sp_no
// 202607170002 (通用申请): a form File control with a file_id, plus two
// comments each carrying a media_id. Trimmed to the fields we parse.
const sampleApprovalDetail = `{
  "errcode": 0, "errmsg": "ok",
  "info": {
    "sp_no": "202607170002", "sp_name": "通用申请", "sp_status": 1,
    "apply_data": { "contents": [
      { "control": "Text", "id": "Text-1", "title": [{"text":"申请事项","lang":"zh_CN"}], "value": {"text":"哈哈2"} },
      { "control": "File", "id": "File-1", "title": [{"text":"附件","lang":"zh_CN"}],
        "value": { "files": [{"file_id":"WWME_FORMFILE"}] } }
    ]},
    "sp_record": [
      { "details": [ { "approver": {"userid":"zhuyx"}, "media_id": [] } ] }
    ],
    "comments": [
      { "commentcontent": "哦哦2", "commentUserInfo": {"userid":"zhuyx"}, "media_id": ["WWME_COMMENT_A"] },
      { "commentcontent": "哦哦",  "commentUserInfo": {"userid":"zhuyx"}, "media_id": ["WWME_COMMENT_B"] }
    ]
  }
}`

func TestExtractApprovalAttachments(t *testing.T) {
	atts, err := ExtractApprovalAttachments(json.RawMessage(sampleApprovalDetail))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(atts) != 3 {
		t.Fatalf("want 3 attachments, got %d: %+v", len(atts), atts)
	}
	// Form File control first.
	if atts[0].ID != "WWME_FORMFILE" || atts[0].Kind != "file_id" || atts[0].Source != "form" || atts[0].Label != "附件" {
		t.Errorf("form attachment wrong: %+v", atts[0])
	}
	// Then the two comments, in order.
	if atts[1].ID != "WWME_COMMENT_A" || atts[1].Source != "comment" || atts[1].Label != "哦哦2" {
		t.Errorf("comment A wrong: %+v", atts[1])
	}
	if atts[2].ID != "WWME_COMMENT_B" || atts[2].Source != "comment" || atts[2].Label != "哦哦" {
		t.Errorf("comment B wrong: %+v", atts[2])
	}
}

// Nested Table/子表单 File controls must be found via value.children[].list[].
func TestExtractApprovalAttachments_Nested(t *testing.T) {
	nested := `{
	  "errcode": 0,
	  "info": { "apply_data": { "contents": [
	    { "control": "Table", "title": [{"text":"明细","lang":"zh_CN"}], "value": {
	      "children": [ { "list": [
	        { "control": "File", "title": [{"text":"行内附件","lang":"zh_CN"}], "value": {"files":[{"file_id":"WWME_NESTED"}]} }
	      ] } ]
	    }}
	  ]}}
	}`
	atts, err := ExtractApprovalAttachments(json.RawMessage(nested))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(atts) != 1 || atts[0].ID != "WWME_NESTED" || atts[0].Label != "行内附件" {
		t.Fatalf("nested File not found correctly: %+v", atts)
	}
}

// A WeCom error payload must surface as an error, not empty success.
func TestExtractApprovalAttachments_Error(t *testing.T) {
	_, err := ExtractApprovalAttachments(json.RawMessage(`{"errcode":301026,"errmsg":"has no sp_no data"}`))
	if err == nil {
		t.Fatal("want error for errcode!=0, got nil")
	}
}

func TestValidApprovalStatus(t *testing.T) {
	for _, code := range []string{"1", "2", "3", "4", "6", "7", "10"} {
		if !ValidApprovalStatus(code) {
			t.Errorf("status %q should be valid", code)
		}
		if ApprovalStatusName(code) == "" {
			t.Errorf("status %q should have a name", code)
		}
	}
	for _, bad := range []string{"0", "5", "8", "99", "", "abc"} {
		if ValidApprovalStatus(bad) {
			t.Errorf("status %q should be invalid", bad)
		}
	}
}

// No attachments anywhere -> empty slice, no error.
func TestExtractApprovalAttachments_None(t *testing.T) {
	atts, err := ExtractApprovalAttachments(json.RawMessage(`{"errcode":0,"info":{"apply_data":{"contents":[]},"comments":[],"sp_record":[]}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(atts) != 0 {
		t.Fatalf("want 0, got %d", len(atts))
	}
}
