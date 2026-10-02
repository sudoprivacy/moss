package client

import (
	"encoding/json"
	"errors"
	"net/url"
)

// Internal group chats (企微内部群, WeCom "appchat").
//
// A different product from 客户群, and the differences drive the whole design:
//
//	                  客户群 (external)          内部群 (internal)
//	daily cap         1 per group per day       none
//	human step        admin approval + sender    none — the call IS the delivery
//	                  confirmation
//	sender identity   `sender` is mandatory      no such field; always the app
//	discovery         groupchat/list             none — no list/search exists
//
// Consequences worth knowing before using these:
//
//   - No queue is needed. There is no quota to reserve, nothing to reconcile,
//     nothing to reap. Send and you are done.
//   - The app's 可见范围 must be 根部门 or every call fails with 48002 — a list
//     of individual members is not enough, however many.
//   - `appchat/send` only reaches groups THIS app created, and WeCom offers no
//     way to enumerate internal groups, so a chat id can only come from
//     CreateInternalGroup. A group someone made in the WeCom client is
//     unreachable and its id unobtainable.

type InternalGroupCreateResp struct {
	OK     bool   `json:"ok"`
	ChatID string `json:"chatId"`
}

type InternalGroupSendResp struct {
	OK    bool   `json:"ok"`
	MsgID string `json:"msgId,omitempty"`
}

// CreateInternalGroup creates an internal group chat and returns its chat id.
//
// `chatID` may be empty to let WeCom mint one, but passing your own keeps the
// mapping reproducible — it is the only handle the group will ever have.
// The owner is added to members automatically when missing; WeCom requires at
// least 2 distinct members.
func (c *Client) CreateInternalGroup(id, name, chatID, owner string, members []string) (*InternalGroupCreateResp, error) {
	if name == "" || owner == "" {
		return nil, errors.New("name and owner are required")
	}
	seen := map[string]bool{}
	list := make([]string, 0, len(members)+1)
	for _, m := range append([]string{owner}, members...) {
		if m != "" && !seen[m] {
			seen[m] = true
			list = append(list, m)
		}
	}
	if len(list) < 2 {
		return nil, errors.New("WeCom requires at least 2 distinct members (owner counts as one)")
	}
	body := map[string]any{"name": name, "owner": owner, "userList": list}
	if chatID != "" {
		body["chatId"] = chatID
	}
	var resp InternalGroupCreateResp
	if err := c.post(c.PathPrefix+"/"+url.PathEscape(id)+"/internal-groups", body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// UpdateInternalGroup changes a group's name, owner or members.
//
// Membership was otherwise fixed at creation: WeCom cannot dissolve an
// appchat group, so a group created with the wrong roster could only be
// abandoned. Pass only what should change — omitted fields are left alone.
//
// `userList` replaces the roster; `add`/`del` adjust it. Pick one form:
// WeCom accepts both at once but the outcome is not worth reasoning about.
func (c *Client) UpdateInternalGroup(
	id, chatID, name, owner string,
	userList, add, del []string,
) (*InternalGroupSendResp, error) {
	if chatID == "" {
		return nil, errors.New("chat-id is required")
	}
	if name == "" && owner == "" && len(userList) == 0 && len(add) == 0 && len(del) == 0 {
		return nil, errors.New("nothing to update: pass --name, --owner, --members, --add or --del")
	}
	body := map[string]any{}
	if name != "" {
		body["name"] = name
	}
	if owner != "" {
		body["owner"] = owner
	}
	if len(userList) > 0 {
		body["userList"] = userList
	}
	if len(add) > 0 {
		body["addUserList"] = add
	}
	if len(del) > 0 {
		body["delUserList"] = del
	}
	var resp InternalGroupSendResp
	path := c.PathPrefix + "/" + url.PathEscape(id) + "/internal-groups/" + url.PathEscape(chatID)
	if err := c.patch(path, body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// GetInternalGroup returns the group's raw detail (name, owner, userlist).
func (c *Client) GetInternalGroup(id, chatID string) (json.RawMessage, error) {
	if chatID == "" {
		return nil, errors.New("chat-id is required")
	}
	var raw json.RawMessage
	path := c.PathPrefix + "/" + url.PathEscape(id) + "/internal-groups/" + url.PathEscape(chatID)
	if err := c.get(path, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// SendInternalGroup posts text/markdown (or a file/image by media id) to an
// internal group. There is no sender argument on purpose: WeCom has no such
// parameter and rejects one — the message always shows as the application.
//
// `mentions` produces REAL @-notifications (unlike 客户群, where an @名字 in the
// body is inert text). Verified against a live tenant: the notification comes
// from this list, never from the `@` characters in the text — the same body with
// no mentions notifies nobody. Pass "@all" alone to notify everyone.
func (c *Client) SendInternalGroup(id, chatID, text, format, mediaID, msgType string, mentions []string) (*InternalGroupSendResp, error) {
	if chatID == "" {
		return nil, errors.New("chat-id is required")
	}
	body := map[string]any{}
	if text != "" {
		body["text"] = text
	}
	if format != "" {
		body["format"] = format
	}
	if mediaID != "" {
		body["mediaId"] = mediaID
	}
	if msgType != "" {
		body["msgType"] = msgType
	}
	if len(mentions) > 0 {
		body["mentionedList"] = mentions
	}
	var resp InternalGroupSendResp
	path := c.PathPrefix + "/" + url.PathEscape(id) + "/internal-groups/" + url.PathEscape(chatID) + "/messages"
	if err := c.post(path, body, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}
