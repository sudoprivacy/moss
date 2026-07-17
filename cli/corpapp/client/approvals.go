package client

import (
	"encoding/json"
	"fmt"
	"io"
)

// approvalStatusNames maps WeCom sp_status codes to labels, per
// getapprovalinfo/getapprovaldetail. Used to validate --status and to
// annotate output.
var approvalStatusNames = map[string]string{
	"1":  "审批中",
	"2":  "已通过",
	"3":  "已驳回",
	"4":  "已撤销",
	"6":  "通过后撤销",
	"7":  "已删除",
	"10": "已支付",
}

// ApprovalStatusName returns the human label for an sp_status code, or ""
// if the code is unknown.
func ApprovalStatusName(code string) string { return approvalStatusNames[code] }

// ValidApprovalStatus reports whether code is a documented sp_status
// value.
func ValidApprovalStatus(code string) bool {
	_, ok := approvalStatusNames[code]
	return ok
}

// ApprovalStatusHelp is a one-line summary of the valid --status codes.
const ApprovalStatusHelp = "1=审批中 2=已通过 3=已驳回 4=已撤销 6=通过后撤销 7=已删除 10=已支付"

// ApprovalAttachment is one downloadable file referenced by an approval
// detail. ID is the handle to pass to `corpapp download --media-id`
// (WeCom accepts both media_id and File-control file_id there). Source
// says where in the approval it came from; Label is a human hint (the
// form control title, or the comment content) for picking the right one.
type ApprovalAttachment struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`   // "media_id" | "file_id"
	Source string `json:"source"` // "form" | "comment" | "record"
	Label  string `json:"label"`  // control title / comment text / approver userid
}

// ExtractApprovalAttachments walks a raw getapprovaldetail response and
// returns every downloadable attachment id in a flat list, so callers
// don't have to know WeCom's three nested locations:
//
//   - form File controls: info.apply_data.contents[].value.files[].file_id
//     (recursing into nested controls' value.children[] — Table/子表单)
//   - comment attachments: info.comments[].media_id[]
//   - approver-step attachments: info.sp_record[].details[].media_id[]
//
// The raw bytes are the untouched server passthrough, so this never
// depends on server-side shaping.
func ExtractApprovalAttachments(raw json.RawMessage) ([]ApprovalAttachment, error) {
	var doc struct {
		Errcode int             `json:"errcode"`
		Errmsg  string          `json:"errmsg"`
		Info    json.RawMessage `json:"info"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse approval detail: %w", err)
	}
	if doc.Errcode != 0 {
		return nil, fmt.Errorf("approval detail errcode=%d %s", doc.Errcode, doc.Errmsg)
	}
	var info struct {
		ApplyData struct {
			Contents []approvalControl `json:"contents"`
		} `json:"apply_data"`
		Comments []struct {
			CommentContent string   `json:"commentcontent"`
			MediaID        []string `json:"media_id"`
			CommentUser    struct {
				UserID string `json:"userid"`
			} `json:"commentUserInfo"`
		} `json:"comments"`
		SpRecord []struct {
			Details []struct {
				Approver struct {
					UserID string `json:"userid"`
				} `json:"approver"`
				MediaID []string `json:"media_id"`
			} `json:"details"`
		} `json:"sp_record"`
	}
	if len(doc.Info) > 0 {
		if err := json.Unmarshal(doc.Info, &info); err != nil {
			return nil, fmt.Errorf("parse approval info: %w", err)
		}
	}

	var out []ApprovalAttachment
	// Form File controls (recursive over nested children).
	for _, c := range info.ApplyData.Contents {
		collectControlFiles(c, &out)
	}
	// Comment attachments.
	for _, cm := range info.Comments {
		label := cm.CommentContent
		if label == "" {
			label = cm.CommentUser.UserID
		}
		for _, id := range cm.MediaID {
			out = append(out, ApprovalAttachment{ID: id, Kind: "media_id", Source: "comment", Label: label})
		}
	}
	// Approver-step attachments.
	for _, r := range info.SpRecord {
		for _, d := range r.Details {
			for _, id := range d.MediaID {
				out = append(out, ApprovalAttachment{ID: id, Kind: "media_id", Source: "record", Label: d.Approver.UserID})
			}
		}
	}
	return out, nil
}

// approvalControl is one apply_data control. Only the fields we need to
// find attachments are modelled; the rest of the (large) control shape
// is ignored.
type approvalControl struct {
	Control string `json:"control"`
	Title   []struct {
		Text string `json:"text"`
		Lang string `json:"lang"`
	} `json:"title"`
	Value struct {
		Files []struct {
			FileID string `json:"file_id"`
		} `json:"files"`
		// Nested controls (Table / 子表单) carry their own controls here.
		Children []struct {
			List []approvalControl `json:"list"`
		} `json:"children"`
	} `json:"value"`
}

// collectControlFiles appends a control's File attachments, then recurses
// into any nested child controls (Table/子表单 rows).
func collectControlFiles(c approvalControl, out *[]ApprovalAttachment) {
	title := controlTitle(c)
	for _, f := range c.Value.Files {
		if f.FileID != "" {
			*out = append(*out, ApprovalAttachment{
				ID: f.FileID, Kind: "file_id", Source: "form", Label: title,
			})
		}
	}
	for _, child := range c.Value.Children {
		for _, nested := range child.List {
			collectControlFiles(nested, out)
		}
	}
}

// controlTitle returns the zh_CN title of a control, falling back to the
// first available title or the control type.
func controlTitle(c approvalControl) string {
	for _, t := range c.Title {
		if t.Lang == "zh_CN" && t.Text != "" {
			return t.Text
		}
	}
	if len(c.Title) > 0 && c.Title[0].Text != "" {
		return c.Title[0].Text
	}
	return c.Control
}

// FormatAttachments prints the flat attachment list as an aligned table,
// or a friendly note when there are none.
func FormatAttachments(w io.Writer, atts []ApprovalAttachment) {
	if len(atts) == 0 {
		fmt.Fprintln(w, "(no attachments on this approval)")
		return
	}
	fmt.Fprintf(w, "%-9s  %-8s  %-40s  %s\n", "KIND", "SOURCE", "ID", "LABEL")
	for _, a := range atts {
		fmt.Fprintf(w, "%-9s  %-8s  %-40s  %s\n", a.Kind, a.Source, a.ID, a.Label)
	}
	fmt.Fprintln(w, "\nDownload one with:  corpapp download --app <name> --media-id <ID> --out ./")
}

// FormatAttachmentsJSON prints the flat attachment list as JSON.
func FormatAttachmentsJSON(w io.Writer, atts []ApprovalAttachment) error {
	if atts == nil {
		atts = []ApprovalAttachment{}
	}
	b, err := json.MarshalIndent(atts, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(w, string(b))
	return nil
}
