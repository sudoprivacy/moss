"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { buildHtmlDocument } from "./utils";
import { TextViewer } from "./TextViewer";

export function HTMLViewer({
  content,
  filePath,
  sourceOnly = false,
}: {
  content: string;
  filePath: string;
  sourceOnly?: boolean;
}) {
  const [mode, setMode] = React.useState<"preview" | "source">(sourceOnly ? "source" : "preview");
  const srcDoc = React.useMemo(() => buildHtmlDocument(content, filePath), [content, filePath]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5">
        <Button variant={mode === "preview" ? "default" : "ghost"} size="sm" className="h-8 rounded-full px-3 text-xs" onClick={() => setMode("preview")}>
          预览
        </Button>
        <Button variant={mode === "source" ? "default" : "ghost"} size="sm" className="h-8 rounded-full px-3 text-xs" onClick={() => setMode("source")}>
          源码
        </Button>
      </div>
      {mode === "preview" ? (
        <iframe title={filePath} srcDoc={srcDoc} sandbox="allow-same-origin" className="h-full w-full bg-white" />
      ) : (
        <TextViewer content={content} />
      )}
    </div>
  );
}
