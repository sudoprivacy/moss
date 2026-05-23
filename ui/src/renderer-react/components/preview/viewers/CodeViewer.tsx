"use client";

import * as React from "react";
import SyntaxHighlighter from "react-syntax-highlighter";
import { atomOneDark, atomOneLight } from "react-syntax-highlighter/dist/esm/styles/hljs";
import { ScrollArea } from "@/components/ui/scroll-area";

export function CodeViewer({
  content,
  language,
}: {
  content: string;
  language?: string;
}) {
  const [dark, setDark] = React.useState(() => document.documentElement.classList.contains("dark"));

  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <ScrollArea className="h-full bg-background/70">
      <SyntaxHighlighter
        language={language || "text"}
        style={dark ? atomOneDark : atomOneLight}
        customStyle={{
          margin: 0,
          minHeight: "100%",
          background: "transparent",
          padding: "1.25rem",
          fontSize: "12px",
        }}
        wrapLongLines
      >
        {content}
      </SyntaxHighlighter>
    </ScrollArea>
  );
}
