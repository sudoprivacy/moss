"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, ChevronDown } from "lucide-react";
import { FilePreview } from "@/components/file-preview";
import { CodeViewer } from "@/components/chat/code-viewer";
import { MessageActionBar } from "@/components/chat/message-action-bar";
import { TerminalChrome, CollapsibleContent } from "@/components/chat/terminal-chrome";
import {
  extractShellResult,
  extractTextContent,
  inferLanguage,
  summarizeToolResult,
} from "@/components/chat/tool-utils";
import type {
  ToolResultRenderMessage,
  ToolUseRenderMessage,
} from "@/lib/agent-transcript";

function ResultBody({
  result,
  toolCall,
}: {
  result: ToolResultRenderMessage;
  toolCall?: ToolUseRenderMessage;
}) {
  const shell = extractShellResult(result.rawContent);
  const text = extractTextContent(result.rawContent ?? result.content).trim() || result.content;
  const filePath =
    typeof toolCall?.input === "object" && toolCall?.input && "file_path" in toolCall.input
      ? typeof (toolCall.input as Record<string, unknown>).file_path === "string"
        ? String((toolCall.input as Record<string, unknown>).file_path)
        : undefined
      : undefined;

  if (shell && (shell.stdout || shell.stderr)) {
    return (
      <TerminalChrome title={toolCall?.displayName || result.toolName}>
        <div className="space-y-0 border-t-0">
          {shell.stdout ? (
            <CollapsibleContent content={shell.stdout} maxLines={3} />
          ) : null}
          {shell.stderr ? (
            <>
              {shell.stdout ? <div className="border-t border-white/10" /> : null}
              <CollapsibleContent content={shell.stderr} maxLines={3} isError />
            </>
          ) : null}
        </div>
      </TerminalChrome>
    );
  }

  if (text) {
    return (
      <CodeViewer
        code={text}
        language={inferLanguage(filePath, "text")}
        title={result.isError ? "error output" : "tool output"}
        maxLines={8}
      />
    );
  }

  return null;
}

export function ToolResultBlock({
  result,
  toolCall,
  compact = false,
}: {
  result: ToolResultRenderMessage;
  toolCall?: ToolUseRenderMessage;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const attachments = result.attachments || [];
  const copyText = extractTextContent(result.rawContent ?? result.content) || result.content;
  const resultSummary = summarizeToolResult(result);

  if (compact && !expanded) {
    return null;
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 select-none"
      >
        {result.isError ? (
          <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
        )}
        <span className="truncate text-xs text-muted-foreground hover:text-foreground">
          {resultSummary || (result.isError ? "Error" : "Result")}
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-[var(--color-surface-container-lowest)]">
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left select-none hover:bg-muted/30 transition-colors"
      >
        {result.isError ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        )}
        <span className="truncate text-[11px] font-medium text-foreground">
          {result.isError ? "Error" : "Result"}
        </span>
        {resultSummary ? (
          <span className="truncate text-[10px] text-muted-foreground">{resultSummary}</span>
        ) : null}
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {!compact ? <MessageActionBar copyText={copyText} copyLabel="复制" className="opacity-0 group-hover/tool-result:opacity-100" /> : null}
      </button>

      <div className="space-y-2 px-3 py-3 select-text">
        <ResultBody result={result} toolCall={toolCall} />

        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <FilePreview
                key={`${attachment.kind}:${attachment.path}`}
                path={attachment.path}
                readonly
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}