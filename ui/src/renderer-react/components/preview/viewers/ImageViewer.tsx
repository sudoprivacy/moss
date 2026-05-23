"use client";

import * as React from "react";
import { Image as ImageIcon } from "lucide-react";

export function ImageViewer({ filePath, alt }: { filePath: string; alt: string }) {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void window.agentDesktop.fs.getImageBase64(filePath).then((dataUrl) => {
      if (!cancelled) {
        setImageSrc(dataUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[radial-gradient(circle_at_top,_rgba(148,163,184,0.16),_transparent_52%),linear-gradient(180deg,rgba(15,23,42,0.04),transparent)] p-5">
      {imageSrc ? (
        <img src={imageSrc} alt={alt} className="max-h-full max-w-full rounded-2xl border border-border/70 bg-background shadow-2xl object-contain" />
      ) : (
        <div className="flex h-full min-h-[240px] w-full items-center justify-center rounded-2xl border border-dashed border-border/70 bg-background/80 text-muted-foreground">
          <div className="flex items-center gap-2 text-sm">
            <ImageIcon className="h-4 w-4" />
            <span>图片加载失败</span>
          </div>
        </div>
      )}
    </div>
  );
}
