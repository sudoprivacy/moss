"use client";

export function URLViewer({ url }: { url: string }) {
  return <iframe title={url} src={url} sandbox="allow-same-origin allow-scripts allow-forms allow-popups" className="h-full w-full bg-background" />;
}
