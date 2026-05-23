"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { documentIpc } from "@/ipc/document.ipc";
import { libreOfficeIpc } from "@/ipc/libreoffice.ipc";
import { shellIpc } from "@/ipc/shell.ipc";
import { LibreOfficeInstallPrompt } from "@/components/preview/LibreOfficeInstallPrompt";
import { PDFViewer } from "./PDFViewer";
import { UnsupportedViewer } from "./UnsupportedViewer";

const pdfCache = new Map<string, { pdfPath: string; timestamp: number }>();
const CACHE_TIMEOUT = 5 * 60 * 1000;

export function PPTViewer({ filePath }: { filePath: string }) {
  const [pdfPath, setPdfPath] = React.useState<string>();
  const [pptData, setPptData] = React.useState<any | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [needsInstall, setNeedsInstall] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);
  const [installPercent, setInstallPercent] = React.useState<number>();
  const [installPhase, setInstallPhase] = React.useState<string>();
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    const unsubProgress = libreOfficeIpc.onInstallProgress(({ phase, percent }) => {
      setInstalling(true);
      setInstallPhase(phase);
      if (percent != null) setInstallPercent((prev) => (prev != null ? Math.max(prev, percent) : percent));
    });
    const unsubResult = libreOfficeIpc.onInstallResult(({ success }) => {
      setInstalling(false);
      setInstallPercent(undefined);
      setInstallPhase(undefined);
      if (success) {
        setNeedsInstall(false);
        setReloadToken((n) => n + 1);
      }
    });
    return () => {
      unsubProgress();
      unsubResult();
    };
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setPdfPath(undefined);
    setPptData(null);
    try {
      const cached = pdfCache.get(filePath);
      if (cached && Date.now() - cached.timestamp < CACHE_TIMEOUT) {
        setPdfPath(cached.pdfPath);
        return;
      }
      if (cached) pdfCache.delete(filePath);

      const libreOfficeAvailable = await documentIpc.libreOffice.isAvailable();
      if (libreOfficeAvailable) {
        const pdfResponse = await documentIpc.convert({ filePath, to: "libreoffice-pdf" });
        if (pdfResponse?.result?.success && pdfResponse.result.data) {
          setPdfPath(pdfResponse.result.data);
          pdfCache.set(filePath, { pdfPath: pdfResponse.result.data, timestamp: Date.now() });
          return;
        }
      }

      const pptResponse = await documentIpc.convert({ filePath, to: "ppt-json" });
      if (pptResponse?.result?.success && pptResponse.result.data?.slides?.length) {
        setPptData(pptResponse.result.data);
        return;
      }

      setNeedsInstall(true);
      setError(pptResponse?.result?.error || "无法降级预览该 PowerPoint 文件。");
    } catch (err) {
      setNeedsInstall(true);
      setError(err instanceof Error ? err.message : "PowerPoint 预览失败。");
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  React.useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const handleInstall = React.useCallback(async () => {
    setInstalling(true);
    await libreOfficeIpc.install();
  }, []);

  if (loading) {
    return <UnsupportedViewer title="正在加载 PowerPoint 预览" description="正在尝试 LibreOffice 与降级解析链。" />;
  }

  if (pdfPath) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-end gap-2 border-b border-border/70 px-4 py-2.5">
          <Button variant="ghost" size="sm" className="rounded-full text-xs" onClick={() => void load()}>
            刷新
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full text-xs" onClick={() => void shellIpc.openFile(filePath)}>
            用系统应用打开
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <PDFViewer filePath={pdfPath} title={filePath} />
        </div>
      </div>
    );
  }

  if (pptData?.slides?.length) {
    return (
      <div className="h-full overflow-auto p-5">
        <div className="mx-auto max-w-5xl space-y-4">
          {pptData.slides.map((slide: any) => (
            <section key={slide.slideNumber} className="rounded-[24px] border border-border/70 bg-card/80 p-5 shadow-[0_18px_60px_-48px_rgba(0,0,0,0.65)]">
              <div className="mb-4 text-sm font-medium text-foreground">Slide {slide.slideNumber}</div>
              <div className="space-y-4">
                {(slide.content?.elements || []).map((element: any, index: number) => {
                  if (element.type === "text") {
                    return <div key={index} className="whitespace-pre-wrap text-sm leading-7 text-foreground">{element.content}</div>;
                  }
                  if (element.type === "image") {
                    const src = pptData.raw?._mediaResources?.[element.ref];
                    if (src) {
                      return <img key={index} src={src} alt={element.ref} className="max-w-full rounded-2xl border border-border/70" />;
                    }
                  }
                  return null;
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  }

  if (needsInstall) {
    return (
      <LibreOfficeInstallPrompt
        fileType="ppt"
        installing={installing}
        percent={installPercent}
        phase={installPhase}
        onInstall={handleInstall}
      />
    );
  }

  return <UnsupportedViewer title="PowerPoint 预览失败" description={error || "无法打开该 PowerPoint 文档。"} tone="warning" />;
}
