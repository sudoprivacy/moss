"use client";

import { FilePreview } from "@/components/file-preview";
import { MessageActionBar } from "@/components/chat/message-action-bar";
import { MarkdownRenderer } from "@/components/markdown/markdown-renderer";
import type { AssistantTextRenderMessage } from "@/lib/agent-transcript";

function shouldUseDocumentLayout(content: string, attachmentCount: number) {
  const normalized = content.trim();
  if (attachmentCount > 0) return true;
  if (!normalized) return false;
  if (/```/.test(normalized)) return true;
  if (/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|.+\|)/m.test(normalized)) return true;

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return paragraphs.length >= 2 || normalized.split("\n").filter((line) => line.trim()).length >= 8;
}

export function AssistantMessage({ message }: { message: AssistantTextRenderMessage }) {
  const attachments = message.attachments || [];
  const hasText = message.content.trim().length > 0;
  const documentLayout = shouldUseDocumentLayout(message.content, attachments.length);

  return (
    <div className="group mb-5 flex justify-start gap-2">
      <img
        src="./build/icon.png"
        alt="Moss"
        className="h-7 w-7 shrink-0 self-start rounded-sm object-contain"
      />
      <div
        data-message-shell="assistant"
        data-layout={documentLayout ? "document" : "bubble"}
        className={
          documentLayout
            ? "flex w-full min-w-0 flex-col items-start gap-2"
            : "flex w-full max-w-[88%] min-w-0 flex-col items-start gap-2 sm:max-w-[80%] lg:max-w-[72%]"
        }
      >
        {(hasText || attachments.length > 0) && (
          <div className="w-full max-w-full rounded-[20px] rounded-tl-[8px] border border-border/70 bg-card/92 px-4 py-3 shadow-[0_18px_48px_-40px_rgba(0,0,0,0.75)] select-text">
            {hasText && (
              <MarkdownRenderer content={message.content} variant={documentLayout ? "document" : "default"} />
            )}

            {attachments.length > 0 && (
              <div className={hasText ? "mt-3 flex flex-wrap gap-2" : "flex flex-wrap gap-2"}>
                {attachments.map((attachment) => (
                  <FilePreview
                    key={`${attachment.kind}:${attachment.path}`}
                    path={attachment.path}
                    readonly
                  />
                ))}
              </div>
            )}

            {message.streaming && hasText && (
              <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-primary align-text-bottom" />
            )}

            {message.meta && message.meta.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {message.meta.map((entry) => (
                  <span
                    key={entry}
                    className="rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {entry}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {hasText && (
          <MessageActionBar
            copyText={message.content}
            copyLabel="复制回复"
            align="start"
          />
        )}
      </div>
    </div>
  );
}
