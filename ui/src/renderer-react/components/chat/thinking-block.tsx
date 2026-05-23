"use client";

import * as React from "react";

export function ThinkingBlock({
  content,
  isActive = false,
}: {
  content: string;
  isActive?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (expanded && isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, expanded, isActive]);

  const preview = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/g, " ")
    .slice(0, 96) || "";

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="text-[10px]">{expanded ? "▾" : "▸"}</span>
        <span className="shrink-0 italic">
          Thinking
          {isActive ? <span className="ml-1 inline-block animate-pulse">...</span> : null}
        </span>
        {!expanded && preview ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {preview}
          </span>
        ) : null}
      </button>
      {expanded && (
        <div
          ref={contentRef}
          className="mt-1 max-h-[300px] overflow-y-auto rounded-2xl border border-border/60 bg-card/60 p-3 font-mono text-[11px] leading-6 text-muted-foreground whitespace-pre-wrap break-words"
        >
          {content}
          {isActive ? <span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-muted-foreground align-text-bottom" /> : null}
        </div>
      )}
    </div>
  );
}
