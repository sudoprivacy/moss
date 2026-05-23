"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/components/chat/clipboard";

export function CopyButton({
  text,
  label = "复制",
  className,
}: {
  text?: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  if (!text) return null;

  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyToClipboard(text);
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
      title={label}
      aria-label={label}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? "已复制" : label}</span>
    </button>
  );
}
