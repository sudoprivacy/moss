"use client";

import { CodeViewer } from "./CodeViewer";

export function DiffViewer({ content }: { content: string }) {
  return <CodeViewer content={content} language="diff" />;
}
