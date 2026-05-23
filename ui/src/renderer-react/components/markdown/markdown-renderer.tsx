"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { LocalImage } from "@/components/local-image";
import { CodeViewer } from "@/components/chat/code-viewer";
import { MermaidRenderer } from "@/components/chat/mermaid-renderer";

function looksInline(code: string) {
  return !code.includes("\n");
}

export function MarkdownRenderer({
  content,
  variant = "default",
}: {
  content: string;
  variant?: "default" | "document";
}) {
  return (
    <div
      className={cn(
        "prose prose-sm min-w-0 max-w-none break-words dark:prose-invert [overflow-wrap:anywhere] [&_*]:max-w-full",
        variant === "document" && "prose-headings:scroll-mt-20 prose-pre:my-0",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children, ...props }: any) => {
            const code = String(children || "").replace(/\n$/, "");
            const match = /language-([\w-]+)/.exec(className || "");
            const language = match?.[1] || "text";

            if (looksInline(code)) {
              return (
                <code
                  className={cn("rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em]", className)}
                  {...props}
                >
                  {children}
                </code>
              );
            }

            if (language === "mermaid") {
              return <MermaidRenderer code={code} />;
            }

            return <CodeViewer code={code} language={language} maxLines={24} showLineNumbers />;
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-4 hover:underline"
              onClick={(event) => {
                if (typeof href === "string" && /^https?:/i.test(href)) {
                  event.preventDefault();
                  void window.agentDesktop.shell.openExternal(href);
                }
              }}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-2xl border border-border/70">
              <table className="min-w-full">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="bg-muted/60 px-3 py-2 text-left text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border-t border-border/60 px-3 py-2 align-top">{children}</td>,
          blockquote: ({ children }) => (
            <blockquote className="my-4 rounded-r-2xl border-l-4 border-[var(--color-outline-variant)] bg-[var(--color-surface-container-low)] px-4 py-2 text-[var(--color-text-secondary)]">
              {children}
            </blockquote>
          ),
          h1: ({ children }) => <h1 className="mb-4 mt-2 text-2xl font-semibold leading-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-8 border-b border-border/70 pb-2 text-xl font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-6 text-base font-semibold">{children}</h3>,
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap break-words leading-7">{children}</p>,
          ul: ({ children }) => <ul className="my-3 list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal pl-5">{children}</ol>,
          li: ({ children }) => <li className="my-1.5 break-words">{children}</li>,
          img: ({ src, alt }) => (
            <LocalImage
              src={typeof src === "string" ? src : ""}
              alt={alt}
              className="my-3 rounded-2xl border border-border/60"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
