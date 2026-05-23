"use client";

import * as React from "react";
import { CopyButton } from "@/components/shared/copy-button";
import { inferLanguage } from "@/components/chat/tool-utils";

type DiffLine = {
  type: "added" | "removed" | "unchanged";
  oldNumber?: number;
  newNumber?: number;
  text: string;
};

function buildLcsTable(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }
  return table;
}

function buildDiffLines(oldString: string, newString: string): DiffLine[] {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  if (oldLines.length * newLines.length > 80_000) {
    return newString.split("\n").map((line, index) => ({
      type: "added" as const,
      newNumber: index + 1,
      text: line,
    }));
  }

  const table = buildLcsTable(oldLines, newLines);
  const result: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      result.push({
        type: "unchanged",
        oldNumber: oldIndex + 1,
        newNumber: newIndex + 1,
        text: oldLines[oldIndex]!,
      });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      result.push({
        type: "removed",
        oldNumber: oldIndex + 1,
        text: oldLines[oldIndex]!,
      });
      oldIndex += 1;
    } else {
      result.push({
        type: "added",
        newNumber: newIndex + 1,
        text: newLines[newIndex]!,
      });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    result.push({
      type: "removed",
      oldNumber: oldIndex + 1,
      text: oldLines[oldIndex]!,
    });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    result.push({
      type: "added",
      newNumber: newIndex + 1,
      text: newLines[newIndex]!,
    });
    newIndex += 1;
  }

  return result;
}

function getDiffLineClassName(type: DiffLine["type"]) {
  if (type === "added") {
    return "bg-[var(--color-diff-added-bg)] text-[var(--color-text-primary)]";
  }
  if (type === "removed") {
    return "bg-[var(--color-diff-removed-bg)] text-[var(--color-text-primary)]";
  }
  return "bg-[var(--color-code-bg)] text-[var(--color-code-fg)]";
}

export function DiffViewer({
  filePath,
  oldString,
  newString,
  maxLines = 16,
}: {
  filePath: string;
  oldString: string;
  newString: string;
  maxLines?: number;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const diffLines = React.useMemo(
    () => buildDiffLines(oldString, newString),
    [newString, oldString],
  );
  const visibleLines = expanded ? diffLines : diffLines.slice(0, maxLines);
  const additions = diffLines.filter((line) => line.type === "added").length;
  const deletions = diffLines.filter((line) => line.type === "removed").length;
  const language = inferLanguage(filePath, "diff");
  const patchText = React.useMemo(() => {
    const body = [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      ...diffLines.map((line) => {
        if (line.type === "added") return `+${line.text}`;
        if (line.type === "removed") return `-${line.text}`;
        return ` ${line.text}`;
      }),
    ];
    return body.join("\n");
  }, [diffLines, filePath]);

  return (
    <div className="overflow-hidden rounded-[18px] border border-border/60 bg-[var(--color-surface-container-low)]">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-[var(--color-surface-container)] px-3 py-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] text-[var(--color-text-secondary)]">{filePath}</div>
          <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em]">
            <span className="rounded-full bg-[var(--color-diff-added-bg)] px-2 py-0.5 text-[var(--color-diff-added-text)]">+{additions}</span>
            <span className="rounded-full bg-[var(--color-diff-removed-bg)] px-2 py-0.5 text-[var(--color-diff-removed-text)]">-{deletions}</span>
            <span className="text-[var(--color-text-tertiary)]">{language}</span>
          </div>
        </div>
        <CopyButton text={patchText} label="复制 diff" />
      </div>

      <div className="max-h-[420px] overflow-auto bg-[var(--color-code-bg)] font-mono text-[12px] leading-6 select-text">
        {visibleLines.map((line, index) => (
          <div
            key={`${line.type}-${line.oldNumber ?? "x"}-${line.newNumber ?? "y"}-${index}`}
            className={`grid grid-cols-[56px_56px_1fr] gap-0 ${getDiffLineClassName(line.type)}`}
          >
            <div className="select-none border-r border-black/5 px-2 py-0.5 text-right text-[10px] text-[var(--color-text-tertiary)]">
              {line.oldNumber ?? ""}
            </div>
            <div className="select-none border-r border-black/5 px-2 py-0.5 text-right text-[10px] text-[var(--color-text-tertiary)]">
              {line.newNumber ?? ""}
            </div>
            <pre className="overflow-x-auto px-3 py-0.5 whitespace-pre-wrap break-words">{line.text || " "}</pre>
          </div>
        ))}
      </div>

      {diffLines.length > maxLines ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="w-full border-t border-border/60 bg-[var(--color-surface-container)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
        >
          {expanded ? "收起" : `显示剩余 ${diffLines.length - maxLines} 行`}
        </button>
      ) : null}
    </div>
  );
}
