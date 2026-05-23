"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LocalImage } from "@/components/local-image";

export function MarkdownViewer({ content }: { content: string }) {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl px-5 py-6 text-sm leading-7 text-foreground">
        <div className="space-y-4 [&_a]:text-primary [&_code]:rounded-md [&_code]:bg-muted/80 [&_code]:px-1.5 [&_code]:py-0.5 [&_img]:rounded-xl [&_img]:border [&_img]:border-border/70 [&_img]:shadow-sm [&_li]:ml-5 [&_pre]:overflow-auto [&_pre]:rounded-2xl [&_pre]:border [&_pre]:border-border/70 [&_pre]:bg-card/80 [&_pre]:p-4">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ src, alt }) => (
                <LocalImage
                  src={typeof src === "string" ? src : ""}
                  alt={alt}
                  className="rounded-xl border border-border/70 shadow-sm"
                />
              ),
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </ScrollArea>
  );
}
