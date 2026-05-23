"use client";

import * as React from "react";
import SyntaxHighlighter from "react-syntax-highlighter";
import { vs, vs2015 } from "react-syntax-highlighter/dist/esm/styles/hljs";
import { CopyButton } from "@/components/shared/copy-button";

export function CodeViewer({
  code,
  language = "text",
  title,
  maxLines = 12,
  showLineNumbers = true,
}: {
  code: string;
  language?: string;
  title?: string;
  maxLines?: number;
  showLineNumbers?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [dark, setDark] = React.useState(() => document.documentElement.getAttribute("data-theme") === "dark");

  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.getAttribute("data-theme") === "dark");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  const allLines = React.useMemo(() => code.split("\n"), [code]);
  const lineCount = allLines.length;
  const isTruncated = !expanded && lineCount > maxLines;
  const visibleCode = React.useMemo(
    () => (isTruncated ? allLines.slice(0, maxLines).join("\n") : code),
    [allLines, code, isTruncated, maxLines],
  );

  return (
    <div className="overflow-hidden rounded-[18px] border border-border/60 bg-[var(--color-surface-container-low)]">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-[var(--color-surface-container)] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">
            {title || language || "code"}
          </div>
          <div className="text-[10px] text-[var(--color-text-tertiary)]">
            {lineCount} 行
          </div>
        </div>
        <CopyButton text={code} label="复制代码" />
      </div>

      <div className="max-h-[420px] overflow-auto bg-[var(--color-code-bg)] select-text">
        <SyntaxHighlighter
          language={language}
          style={dark ? vs2015 : vs}
          PreTag="div"
          wrapLongLines
          showLineNumbers={showLineNumbers && language !== "text" && language !== "plaintext"}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            background: "transparent",
            padding: "12px",
            fontSize: "12px",
            lineHeight: "1.55",
          }}
          lineNumberStyle={{
            minWidth: "2.5em",
            paddingRight: "1em",
            color: "var(--color-text-tertiary)",
            userSelect: "none",
          }}
        >
          {visibleCode}
        </SyntaxHighlighter>
      </div>

      {lineCount > maxLines ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="w-full border-t border-border/60 bg-[var(--color-surface-container)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
        >
          {expanded ? "收起" : `显示剩余 ${lineCount - maxLines} 行`}
        </button>
      ) : null}
    </div>
  );
}
