"use client";

import { ScrollArea } from "@/components/ui/scroll-area";

export function TextViewer({ content }: { content: string }) {
  return (
    <ScrollArea className="h-full">
      <pre className="min-h-full whitespace-pre-wrap break-words px-5 py-4 text-[12px] leading-6 text-foreground">
        {content}
      </pre>
    </ScrollArea>
  );
}
