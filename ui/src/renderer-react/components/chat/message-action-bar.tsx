"use client";

import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/shared/copy-button";

export function MessageActionBar({
  copyText,
  copyLabel,
  align = "start",
  className,
}: {
  copyText?: string;
  copyLabel?: string;
  align?: "start" | "end";
  className?: string;
}) {
  if (!copyText) return null;

  return (
    <div
      className={cn(
        "flex w-full opacity-0 transition-opacity duration-150 group-hover:opacity-100",
        align === "end" ? "justify-end" : "justify-start",
        className,
      )}
    >
      <CopyButton text={copyText} label={copyLabel} />
    </div>
  );
}
