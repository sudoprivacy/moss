"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { CopyButton } from "@/components/shared/copy-button";
import { X, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

let mermaidInitialized = false;

function initMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    securityLevel: "strict",
    suppressErrorRendering: true,
    fontFamily: "var(--font-sans)",
  });
  mermaidInitialized = true;
}

let mermaidIdCounter = 0;

function parseSvgMetrics(svg: string): { width: number; height: number } | null {
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/i);
  if (viewBoxMatch) {
    const viewBox = viewBoxMatch[1];
    if (!viewBox) return null;
    const values = viewBox.split(/[\s,]+/).map((part) => Number.parseFloat(part));
    if (values.length === 4 && values.every((v) => Number.isFinite(v))) {
      const [, , width, height] = values;
      if (width !== undefined && height !== undefined) {
        return { width, height };
      }
    }
  }
  const widthMatch = svg.match(/\bwidth="([0-9.]+)(?:px)?"/i);
  const heightMatch = svg.match(/\bheight="([0-9.]+)(?:px)?"/i);
  if (widthMatch && heightMatch) {
    const width = Number.parseFloat(widthMatch[1]);
    const height = Number.parseFloat(heightMatch[1]);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      return { width, height };
    }
  }
  return null;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function MermaidRenderer({ code }: { code: string }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [svg, setSvg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [previewZoom, setPreviewZoom] = React.useState(1);

  React.useEffect(() => {
    let cancelled = false;
    initMermaid();
    const id = `mermaid-${++mermaidIdCounter}`;
    mermaid.render(id, code).then(
      ({ svg: renderedSvg }) => {
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      },
      (err) => {
        if (!cancelled) {
          setError(String(err?.message || err));
          setSvg(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  const svgMetrics = svg ? parseSvgMetrics(svg) : null;

  const zoomIn = React.useCallback(() => setPreviewZoom((v) => clampZoom(v + ZOOM_STEP)), []);
  const zoomOut = React.useCallback(() => setPreviewZoom((v) => clampZoom(v - ZOOM_STEP)), []);
  const resetZoom = React.useCallback(() => setPreviewZoom(1), []);

  React.useEffect(() => {
    if (!previewOpen) setPreviewZoom(1);
  }, [previewOpen]);

  if (error) {
    return (
      <div className="my-4 overflow-hidden rounded-[18px] border border-destructive/30">
        <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
          Mermaid Error
        </div>
        <div className="bg-destructive/5 px-3 py-2 font-mono text-[11px] text-destructive">
          {error}
        </div>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-4 flex items-center justify-center rounded-[18px] border border-border/50 bg-muted/30 py-8">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
          Rendering diagram...
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="my-4 overflow-hidden rounded-[18px] border border-border/60 bg-[var(--color-surface-container-low)]">
        <div className="flex items-center justify-between border-b border-border/60 bg-[var(--color-surface-container)] px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">
            Mermaid
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPreviewOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Maximize2 className="h-3 w-3" />
              放大
            </button>
            <CopyButton text={code} label="复制" />
          </div>
        </div>
        <div
          ref={containerRef}
          className="flex cursor-pointer items-center justify-center overflow-auto bg-white p-4 dark:bg-white"
          style={{ maxHeight: 400 }}
          onClick={() => setPreviewOpen(true)}
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }),
          }}
        />
      </div>

      <AnimatePresence>
        {previewOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/50"
              onClick={() => setPreviewOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.15 }}
              className="fixed left-1/2 top-1/2 z-50 w-full max-w-[1100px] -translate-x-1/2 -translate-y-1/2"
            >
              <div className="mx-4 max-h-[85vh] overflow-hidden rounded-2xl border border-border/80 bg-card shadow-2xl">
                <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    Mermaid Diagram
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/50 px-1 py-1">
                      <button
                        type="button"
                        onClick={zoomOut}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label="Zoom out"
                      >
                        <ZoomOut className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={resetZoom}
                        className="min-w-[52px] rounded-md px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {Math.round(previewZoom * 100)}%
                      </button>
                      <button
                        type="button"
                        onClick={zoomIn}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label="Zoom in"
                      >
                        <ZoomIn className="h-4 w-4" />
                      </button>
                    </div>
                    <CopyButton text={code} label="复制" />
                    <button
                      onClick={() => setPreviewOpen(false)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="overflow-auto bg-white p-6" style={{ maxHeight: "calc(85vh - 80px)" }}>
                  <div
                    className="mx-auto"
                    style={
                      svgMetrics
                        ? { width: `${svgMetrics.width * previewZoom}px`, height: `${svgMetrics.height * previewZoom}px` }
                        : undefined
                    }
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }),
                    }}
                  />
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}