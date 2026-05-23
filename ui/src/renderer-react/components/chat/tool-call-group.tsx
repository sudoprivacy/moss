"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCallBlock } from "@/components/chat/tool-call-block";
import { getToolKind, ToolKind } from "@/components/chat/tool-utils";
import type { ToolResultRenderMessage, ToolUseRenderMessage } from "@/lib/agent-transcript";

type Props = {
  toolCalls: ToolUseRenderMessage[];
  resultMap: Map<string, ToolResultRenderMessage>;
  childToolCallsByParent: Map<string, ToolUseRenderMessage[]>;
  isStreaming?: boolean;
};

const kindLabels: Record<ToolKind, string> = {
  bash: "命令",
  read: "读取",
  search: "搜索",
  write: "写入",
  edit: "修改",
  agent: "Agent",
  web: "网页",
  db: "数据库",
  other: "工具",
};

function summarizeGroup(toolCalls: ToolUseRenderMessage[]) {
  const counts = new Map<ToolKind, number>();
  for (const toolCall of toolCalls) {
    const kind = getToolKind(toolCall.toolName, toolCall.input);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => `${kindLabels[kind]} x${count}`)
    .join(" · ");
}

function ToolCallTree({
  toolCall,
  resultMap,
  childToolCallsByParent,
  compact = false,
}: {
  toolCall: ToolUseRenderMessage;
  resultMap: Map<string, ToolResultRenderMessage>;
  childToolCallsByParent: Map<string, ToolUseRenderMessage[]>;
  compact?: boolean;
}) {
  const result = resultMap.get(toolCall.toolUseId);
  const children = childToolCallsByParent.get(toolCall.toolUseId) || [];

  return (
    <ToolCallBlock
      toolCall={toolCall}
      result={result}
      compact={compact}
    >
      {children.length > 0 ? (
        <div className="ml-2 border-l border-border/50 pl-2">
          <div className="space-y-0.5">
            {children.map((child) => (
              <ToolCallTree
                key={child.id}
                toolCall={child}
                resultMap={resultMap}
                childToolCallsByParent={childToolCallsByParent}
                compact
              />
            ))}
          </div>
        </div>
      ) : null}
    </ToolCallBlock>
  );
}

export function ToolCallGroup({
  toolCalls,
  resultMap,
  childToolCallsByParent,
  isStreaming = false,
}: Props) {
  const hasError = toolCalls.some((toolCall) => {
    const result = resultMap.get(toolCall.toolUseId);
    return toolCall.status === "error" || result?.isError;
  });
  const allCompleted = toolCalls.every((toolCall) => {
    const result = resultMap.get(toolCall.toolUseId);
    return (toolCall.status === "success" || Boolean(result)) && toolCall.status !== "running" && toolCall.status !== "pending";
  });
  const completedCount = toolCalls.filter((toolCall) => {
    const result = resultMap.get(toolCall.toolUseId);
    return toolCall.status === "success" || Boolean(result);
  }).length;

  const [expanded, setExpanded] = React.useState(isStreaming);

  React.useEffect(() => {
    if (isStreaming) {
      setExpanded(true);
    }
  }, [isStreaming]);

  if (toolCalls.length === 1) {
    return (
      <ToolCallTree
        toolCall={toolCalls[0]!}
        resultMap={resultMap}
        childToolCallsByParent={childToolCallsByParent}
      />
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[13px] transition-colors hover:bg-muted/50 select-none"
      >
        {hasError ? (
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-destructive" />
        ) : allCompleted ? (
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
        ) : (
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
        )}
        <span className={cn("truncate", allCompleted && !hasError && "text-muted-foreground")}>
          {summarizeGroup(toolCalls)}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {completedCount}/{toolCalls.length}
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border/60">
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left select-none hover:bg-muted/30 transition-colors rounded-t-xl"
      >
        {hasError ? (
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-destructive" />
        ) : allCompleted ? (
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
        ) : (
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
        )}
        <span className="truncate text-sm font-medium text-foreground">
          {summarizeGroup(toolCalls)}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {completedCount}/{toolCalls.length}
        </span>
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground rotate-180" />
      </button>

      <div className="space-y-0.5 px-3 pb-3">
        {toolCalls.map((toolCall) => (
          <ToolCallTree
            key={toolCall.id}
            toolCall={toolCall}
            resultMap={resultMap}
            childToolCallsByParent={childToolCallsByParent}
            compact
          />
        ))}
      </div>
    </div>
  );
}