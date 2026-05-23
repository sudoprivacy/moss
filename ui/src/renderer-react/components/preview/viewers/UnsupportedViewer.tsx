"use client";

import { cn } from "@/lib/utils";

export function UnsupportedViewer({
  title,
  description,
  tone = "default",
}: {
  title: string;
  description: string;
  tone?: "default" | "warning";
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div
        className={cn(
          "max-w-md rounded-[24px] border p-5 text-sm shadow-[0_18px_60px_-48px_rgba(0,0,0,0.7)]",
          tone === "warning"
            ? "border-amber-400/35 bg-amber-500/10 text-amber-950 dark:text-amber-100"
            : "border-border/70 bg-card/80 text-muted-foreground"
        )}
      >
        <div className="text-base font-medium text-foreground">{title}</div>
        <p className="mt-2 leading-6">{description}</p>
      </div>
    </div>
  );
}
