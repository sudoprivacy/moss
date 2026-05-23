"use client";

import * as React from "react";
import { CopyButton } from "@/components/shared/copy-button";

function CollapsibleContent({
  content,
  maxLines = 3,
  className = "",
  isError = false,
}: {
  content: string;
  maxLines?: number;
  className?: string;
  isError?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const lines = content.split("\n");
  const isTruncated = !expanded && lines.length > maxLines;
  const visibleLines = isTruncated ? lines.slice(0, maxLines) : lines;

  return (
    <div>
      <pre
        className={`overflow-x-auto px-3 py-3 text-[12px] leading-6 ${
          isError ? "text-rose-300" : "text-[var(--color-terminal-fg)]"
        } ${className}`}
      >
        <code>{visibleLines.join("\n")}</code>
      </pre>
      {lines.length > maxLines ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-terminal-muted)] transition-colors hover:text-[var(--color-terminal-fg)]"
        >
          {expanded ? "收起" : `显示剩余 ${lines.length - maxLines} 行`}
        </button>
      ) : null}
    </div>
  );
}

export function TerminalChrome({
  title,
  command,
  children,
  maxLines,
}: {
  title?: string;
  command?: string;
  children?: React.ReactNode;
  maxLines?: number;
}) {
  const body = children ?? (
    <pre className="overflow-x-auto px-3 py-3 text-[12px] leading-6 text-[var(--color-terminal-fg)]">
      <code>{command}</code>
    </pre>
  );

  return (
    <div className="overflow-hidden rounded-[18px] border border-[var(--color-terminal-border)] bg-[var(--color-surface-dim)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-terminal-border)] bg-[var(--color-terminal-header)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-terminal-danger)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-terminal-warning)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-terminal-accent)]" />
          </div>
          {title ? (
            <span className="truncate font-mono text-[10px] text-[var(--color-terminal-muted)]">
              {title}
            </span>
          ) : null}
        </div>
        {command ? (
          <CopyButton
            text={command}
            label="复制"
            className="border-white/10 bg-white/5 text-[var(--color-terminal-muted)] hover:text-[var(--color-terminal-fg)]"
          />
        ) : null}
      </div>
      <div className="bg-[var(--color-terminal-bg)] text-[var(--color-terminal-fg)]">{body}</div>
    </div>
  );
}

export { CollapsibleContent };