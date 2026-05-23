"use client";

import * as React from "react";
import { AssistantMessage } from "@/components/chat/assistant-message";
import { ThinkingBlock } from "@/components/chat/thinking-block";
import { ToolCallGroup } from "@/components/chat/tool-call-group";
import { ToolResultBlock } from "@/components/chat/tool-result-block";
import { UserMessage } from "@/components/chat/user-message";
import { WorkspacePathProvider } from "@/components/workspace-path-context";
import type {
  ToolResultRenderMessage,
  ToolUseRenderMessage,
  TranscriptRenderMessage,
} from "@/lib/agent-transcript";

type RenderItem =
  | {
      kind: "tool_group";
      id: string;
      toolCalls: ToolUseRenderMessage[];
    }
  | {
      kind: "message";
      message: Exclude<TranscriptRenderMessage, ToolUseRenderMessage>;
    };

function appendChildToolCall(
  childToolCallsByParent: Map<string, ToolUseRenderMessage[]>,
  parentToolUseId: string,
  toolCall: ToolUseRenderMessage,
) {
  const current = childToolCallsByParent.get(parentToolUseId);
  if (current) {
    current.push(toolCall);
    return;
  }
  childToolCallsByParent.set(parentToolUseId, [toolCall]);
}

function buildRenderModel(messages: TranscriptRenderMessage[]) {
  const renderItems: RenderItem[] = [];
  const resultMap = new Map<string, ToolResultRenderMessage>();
  const childToolCallsByParent = new Map<string, ToolUseRenderMessage[]>();
  const toolUseIds = new Set<string>();
  let pendingToolCalls: ToolUseRenderMessage[] = [];
  const inlineParentToolUseIds = new Set<string>();

  const flushGroup = (resetInlineParents = false) => {
    if (pendingToolCalls.length > 0) {
      renderItems.push({
        kind: "tool_group",
        id: `group-${pendingToolCalls[0]!.id}`,
        toolCalls: [...pendingToolCalls],
      });
      for (const toolCall of pendingToolCalls) {
        inlineParentToolUseIds.add(toolCall.toolUseId);
      }
      pendingToolCalls = [];
    }

    if (resetInlineParents) {
      inlineParentToolUseIds.clear();
    }
  };

  for (const message of messages) {
    if (message.type === "tool_use") {
      toolUseIds.add(message.toolUseId);
    } else if (message.type === "tool_result" && message.toolUseId) {
      resultMap.set(message.toolUseId, message);
    }
  }

  for (const message of messages) {
    if (message.type === "tool_result" && message.toolUseId && toolUseIds.has(message.toolUseId)) {
      continue;
    }

    if (message.type === "tool_use") {
      const parentPending = message.parentToolUseId
        ? pendingToolCalls.some((toolCall) => toolCall.toolUseId === message.parentToolUseId)
        : false;

      if (message.parentToolUseId && (inlineParentToolUseIds.has(message.parentToolUseId) || parentPending)) {
        flushGroup();
        appendChildToolCall(childToolCallsByParent, message.parentToolUseId, message);
        inlineParentToolUseIds.add(message.toolUseId);
        continue;
      }

      pendingToolCalls.push(message);
      continue;
    }

    flushGroup(true);
    renderItems.push({
      kind: "message",
      message,
    });
  }

  flushGroup();
  return { renderItems, resultMap, childToolCallsByParent };
}

function SystemMessage({
  content,
  meta,
}: {
  content: string;
  meta?: string[];
}) {
  return (
    <div className="mb-4 flex justify-center">
      <div className="max-w-[760px] rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs text-muted-foreground">
        {content}
        {meta && meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  bottomRef,
  emptyState,
  workspace,
  loading,
}: {
  messages: TranscriptRenderMessage[];
  bottomRef?: React.RefObject<HTMLDivElement | null>;
  emptyState?: React.ReactNode;
  workspace?: string;
  loading?: boolean;
}) {
  const { renderItems, resultMap, childToolCallsByParent } = React.useMemo(
    () => buildRenderModel(messages),
    [messages],
  );

  React.useEffect(() => {
    bottomRef?.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [bottomRef, messages]);

  return (
    <WorkspacePathProvider workspace={workspace || ""}>
    <div className="mx-auto flex w-full max-w-[980px] min-w-0 flex-col gap-1 px-3 py-3 sm:px-4 sm:py-4">
      {renderItems.length > 0 ? (
        renderItems.map((item) => {
          if (item.kind === "tool_group") {
            return (
              <ToolCallGroup
                key={item.id}
                toolCalls={item.toolCalls}
                resultMap={resultMap}
                childToolCallsByParent={childToolCallsByParent}
                isStreaming={item.toolCalls.some((toolCall) => toolCall.status === "running" || toolCall.status === "pending")}
              />
            );
          }

          const message = item.message;
          if (message.type === "user_text") {
            return <UserMessage key={message.id} message={message} />;
          }
          if (message.type === "assistant_text") {
            return <AssistantMessage key={message.id} message={message} />;
          }
          if (message.type === "thinking") {
            return <ThinkingBlock key={message.id} content={message.content} isActive={Boolean(message.streaming)} />;
          }
          if (message.type === "tool_result") {
            return <ToolResultBlock key={message.id} result={message} />;
          }
          if (message.type === "system") {
            return <SystemMessage key={message.id} content={message.content} meta={message.meta} />;
          }
          return null;
        })
      ) : (
        emptyState || (
          <div className="rounded-[24px] border border-dashed border-border/70 bg-card/50 px-4 py-6 text-sm text-muted-foreground">
            暂无消息
          </div>
        )
      )}

      {loading && (
        <div className="flex justify-start gap-2">
          <img
            src="./build/icon.png"
            alt="Moss"
            className="h-7 w-7 shrink-0 self-start rounded-sm object-contain animate-spin"
            style={{ animationDuration: '2s' }}
          />
          <div className="rounded-[18px] rounded-tl-[8px] border border-border/70 bg-card/92 px-4 py-3 text-sm text-muted-foreground shadow-[0_18px_48px_-40px_rgba(0,0,0,0.75)]">
            working...
          </div>
        </div>
      )}

      {bottomRef ? <div ref={bottomRef} /> : null}
    </div>
    </WorkspacePathProvider>
  );
}
