"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { CodeViewer } from "@/components/chat/code-viewer";
import { DiffViewer } from "@/components/chat/diff-viewer";
import { TerminalChrome, CollapsibleContent } from "@/components/chat/terminal-chrome";
import {
  extractShellResult,
  formatLocator,
  getInputRecord,
  getInputString,
  getToolCommand,
  getToolFilePath,
  getToolKind,
  getToolPatternOrQuery,
  getToolUrl,
  quoteValue,
  summarizeToolResult,
  ToolKind,
  truncate,
  compactWhitespace,
  extractTextContent,
  inferLanguage,
} from "@/components/chat/tool-utils";
import { CopyButton } from "@/components/shared/copy-button";
import type {
  ToolResultRenderMessage,
  ToolUseRenderMessage,
} from "@/lib/agent-transcript";

function statusDot(status: ToolUseRenderMessage["status"]) {
  if (status === "running" || status === "pending") {
    return <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />;
  }
  if (status === "error") {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-destructive" />;
  }
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500" />;
}

function buildHeadline(toolCall: ToolUseRenderMessage, kind: ToolKind) {
  const filePath = getToolFilePath(toolCall);
  const pattern = getToolPatternOrQuery(toolCall);
  const url = getToolUrl(toolCall);

  switch (kind) {
    case "read":
      return filePath ? `Read ${formatLocator(filePath)}` : "Read file";
    case "search":
      return pattern ? `Search ${quoteValue(pattern)}` : "Search";
    case "write":
      return filePath ? `Write ${formatLocator(filePath)}` : "Write file";
    case "edit":
      return filePath ? `Edit ${formatLocator(filePath)}` : "Edit file";
    case "bash":
      return "Bash";
    case "web":
      return url ? `Fetch ${formatLocator(url)}` : "Fetch";
    case "agent":
      return "Agent";
    case "db":
      return "Query";
    default:
      return toolCall.displayName;
  }
}

function buildCollapsedLabel(
  toolCall: ToolUseRenderMessage,
  kind: ToolKind,
  result?: ToolResultRenderMessage,
) {
  const headline = buildHeadline(toolCall, kind);
  const command = getToolCommand(toolCall);

  let detail = "";
  if (kind === "bash" && command) {
    detail = truncate(command, 60);
  }

  const resultSummary = result ? summarizeToolResult(result) : undefined;
  if (resultSummary) {
    detail = detail ? `${detail} — ${resultSummary}` : resultSummary;
  }

  return detail ? `${headline} (${detail})` : headline;
}

function ToolInputPreview({
  toolCall,
  kind,
}: {
  toolCall: ToolUseRenderMessage;
  kind: ToolKind;
}) {
  const input = getInputRecord(toolCall);
  const filePath = getToolFilePath(toolCall) || "file";
  const command = getToolCommand(toolCall);
  const pattern = getToolPatternOrQuery(toolCall);
  const url = getToolUrl(toolCall);
  const description = getInputString(input, ["description"]);

  if (kind === "edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return (
      <DiffViewer
        filePath={filePath}
        oldString={input.old_string}
        newString={input.new_string}
      />
    );
  }

  if (kind === "write" && typeof input.content === "string") {
    return (
      <DiffViewer
        filePath={filePath}
        oldString=""
        newString={input.content}
      />
    );
  }

  if (kind === "bash" && command) {
    return (
      <TerminalChrome title={description || toolCall.displayName} command={command}>
        <div className="px-3 py-2 font-mono text-[12px] leading-[1.5] text-[var(--color-terminal-fg)]">
          <span className="text-[var(--color-terminal-accent)]">$</span> {command}
        </div>
      </TerminalChrome>
    );
  }

  if (kind === "agent") {
    const prompt = getInputString(input, ["prompt", "query"]);
    return (
      <div className="rounded-xl border border-border/60 bg-[var(--color-surface-container-low)] px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Prompt
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--color-text-secondary)]">
          {prompt || description || toolCall.displayName}
        </p>
      </div>
    );
  }

  if (kind === "web" && (url || pattern)) {
    return (
      <div className="rounded-xl border border-border/60 bg-[var(--color-surface-container-low)] px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Request
        </div>
        <p className="mt-1 break-words font-mono text-[12px] leading-5 text-[var(--color-text-secondary)]">
          {url || pattern}
        </p>
      </div>
    );
  }

  if (toolCall.inputText) {
    return (
      <CodeViewer
        code={toolCall.inputText}
        language={kind === "db" ? "sql" : "json"}
        title="input"
        maxLines={8}
        showLineNumbers={kind === "db"}
      />
    );
  }

  return null;
}

function InlineResult({
  result,
  toolCall,
}: {
  result: ToolResultRenderMessage;
  toolCall: ToolUseRenderMessage;
}) {
  const shell = extractShellResult(result.rawContent);
  const text = extractTextContent(result.rawContent ?? result.content).trim() || result.content;

  if (shell && (shell.stdout || shell.stderr)) {
    return (
      <TerminalChrome title={toolCall.displayName}>
        <div className="border-t-0">
          {shell.stdout ? <CollapsibleContent content={shell.stdout} maxLines={3} /> : null}
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
    const filePath =
      typeof toolCall.input === "object" && toolCall.input && "file_path" in toolCall.input
        ? typeof (toolCall.input as Record<string, unknown>).file_path === "string"
          ? String((toolCall.input as Record<string, unknown>).file_path)
          : undefined
        : undefined;

    return (
      <CodeViewer
        code={text}
        language={inferLanguage(filePath, "text")}
        title={result.isError ? "error" : "output"}
        maxLines={8}
      />
    );
  }

  return null;
}

export function ToolCallBlock({
  toolCall,
  result,
  children,
  compact = false,
}: {
  toolCall: ToolUseRenderMessage;
  result?: ToolResultRenderMessage;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  const kind = getToolKind(toolCall.toolName, toolCall.input);
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const [expanded, setExpanded] = React.useState(isRunning);

  React.useEffect(() => {
    if (isRunning) {
      setExpanded(true);
    }
  }, [isRunning]);

  const shellResult = extractShellResult(result?.rawContent);
  const copyText = result
    ? (extractTextContent(result.rawContent ?? result.content) || result.content)
    : toolCall.inputText || "";

  // Collapsed: one line dot + summary
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[13px] transition-colors hover:bg-muted/50 select-none"
      >
        {statusDot(toolCall.status)}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {buildCollapsedLabel(toolCall, kind, result)}
        </span>
        {shellResult?.exitCode !== undefined && shellResult.exitCode !== 0 ? (
          <span className="shrink-0 text-[10px] text-destructive">exit {shellResult.exitCode}</span>
        ) : null}
      </button>
    );
  }

  // Expanded: show input + result inline
  return (
    <div
      className={cn(
        "rounded-xl border",
        toolCall.status === "error"
          ? "border-destructive/30 bg-destructive/5"
          : isRunning
            ? "border-primary/30 bg-primary/5"
            : "border-border/60 bg-card/72",
      )}
    >
      {/* Header: click to collapse */}
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left select-none hover:bg-muted/30 transition-colors rounded-t-xl"
      >
        {statusDot(toolCall.status)}
        <span className="truncate text-sm font-medium text-foreground flex-1">
          {buildHeadline(toolCall, kind)}
        </span>
        {shellResult?.exitCode !== undefined ? (
          <span className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            shellResult.exitCode === 0
              ? "bg-emerald-500/10 text-emerald-600"
              : "bg-destructive/10 text-destructive",
          )}>
            {shellResult.exitCode === 0 ? "0" : shellResult.exitCode}
          </span>
        ) : null}
        <CopyButton text={copyText} label="复制" className="border-border/50 bg-background/50" />
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {/* Body: input + result */}
      <div className="space-y-1.5 px-3 pb-3 select-text">
        <ToolInputPreview toolCall={toolCall} kind={kind} />

        {result ? <InlineResult result={result} toolCall={toolCall} /> : null}

        {result?.attachments && result.attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {result.attachments.map((attachment) => (
              <span key={`${attachment.kind}:${attachment.path}`} className="text-[11px] text-muted-foreground">
                {attachment.path}
              </span>
            ))}
          </div>
        ) : null}

        {children ? (
          <div className="space-y-1 pt-1">{children}</div>
        ) : null}
      </div>
    </div>
  );
}