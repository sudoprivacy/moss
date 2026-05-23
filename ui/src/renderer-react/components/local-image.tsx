"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useWorkspacePath } from "@/components/workspace-path-context";

const imageDataUrlCache = new Map<string, string>();
const imageDataUrlPending = new Map<string, Promise<string | null>>();

function decodeFileUrlToPath(src: string): string | null {
  try {
    const url = new URL(src);
    if (url.protocol !== "file:") return null;
    const decoded = decodeURIComponent(url.pathname || "");
    if (!decoded) return null;
    if (/^\/[A-Za-z]:\//.test(decoded)) {
      return decoded.slice(1);
    }
    return decoded;
  } catch {
    return null;
  }
}

function decodeLocalUrlPath(src: string, protocol: string): string | null {
  try {
    const url = new URL(src);
    if (url.protocol !== protocol) return null;
    const decoded = decodeURIComponent(url.pathname || "");
    if (!decoded) return null;
    if (/^\/[A-Za-z]:\//.test(decoded)) {
      return decoded.slice(1);
    }
    return decoded;
  } catch {
    return null;
  }
}

function resolveImagePath(src: string, workspace: string): string | null {
  const trimmed = String(src || "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("file://")) {
    return decodeFileUrlToPath(trimmed);
  }

  if (trimmed.startsWith("moss-image://")) {
    return decodeLocalUrlPath(trimmed, "moss-image:");
  }

  if (
    trimmed.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\")
  ) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed, "http://local-renderer");
    if (
      /^\/?image$/i.test(url.pathname) ||
      /\/_next\/image$/i.test(url.pathname)
    ) {
      const path = url.searchParams.get("url");
      return path ? decodeURIComponent(path) : null;
    }
  } catch {
    // not a URL-like path
  }

  if (/^(data:|blob:|https?:)/i.test(trimmed)) return null;

  // Relative path: resolve against workspace directory
  if (workspace) {
    const sep = workspace.endsWith("/") ? "" : "/";
    return `${workspace}${sep}${trimmed}`;
  }

  return null;
}

export function LocalImage({
  src,
  alt,
  className,
}: {
  src?: string | null;
  alt?: string;
  className?: string;
}) {
  const workspace = useWorkspacePath();
  const originalSrc = String(src || "").trim();
  const localPath = React.useMemo(
    () => resolveImagePath(originalSrc, workspace),
    [originalSrc, workspace],
  );
  const [resolvedSrc, setResolvedSrc] = React.useState<string | null>(
    localPath ? imageDataUrlCache.get(localPath) || null : originalSrc || null,
  );
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setFailed(false);

    if (!originalSrc) {
      setResolvedSrc(null);
      return () => {
        cancelled = true;
      };
    }

    if (!localPath) {
      // If originalSrc looks like a bare filename (no protocol, no leading /),
      // it's a relative path that we couldn't resolve — show failure state.
      if (originalSrc && !/^(data:|blob:|https?:)/i.test(originalSrc)) {
        setFailed(true);
        setResolvedSrc(null);
      } else {
        setResolvedSrc(originalSrc || null);
      }
      return () => {
        cancelled = true;
      };
    }

    const cached = imageDataUrlCache.get(localPath);
    if (cached) {
      setResolvedSrc(cached);
      return () => {
        cancelled = true;
      };
    }

    const pending = imageDataUrlPending.get(localPath)
      || window.agentDesktop.fs.getImageBase64(localPath).then((dataUrl) => {
        if (dataUrl) {
          imageDataUrlCache.set(localPath, dataUrl);
        }
        imageDataUrlPending.delete(localPath);
        return dataUrl;
      }).catch((error) => {
        imageDataUrlPending.delete(localPath);
        throw error;
      });

    imageDataUrlPending.set(localPath, pending);

    void pending.then((dataUrl) => {
      if (cancelled) return;
      if (dataUrl) {
        setResolvedSrc(dataUrl);
      } else {
        setFailed(true);
      }
    }).catch(() => {
      if (!cancelled) {
        setFailed(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [originalSrc, localPath]);

  if (!resolvedSrc) {
    return (
      <div
        className={cn(
          "my-2 flex min-h-24 items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-4 text-xs text-muted-foreground",
          className,
        )}
      >
        {failed ? (alt || "图片加载失败") : "正在加载图片..."}
      </div>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt || ""}
      className={className}
      onError={() => {
        setFailed(true);
        setResolvedSrc(null);
      }}
    />
  );
}
