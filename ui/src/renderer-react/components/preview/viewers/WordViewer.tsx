"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { documentIpc } from "@/ipc/document.ipc";
import { libreOfficeIpc } from "@/ipc/libreoffice.ipc";
import { shellIpc } from "@/ipc/shell.ipc";
import { LibreOfficeInstallPrompt } from "@/components/preview/LibreOfficeInstallPrompt";
import { PDFViewer } from "./PDFViewer";
import { MarkdownViewer } from "./MarkdownViewer";
import { UnsupportedViewer } from "./UnsupportedViewer";

const pdfCache = new Map<string, { pdfPath: string; timestamp: number }>();
const CACHE_TIMEOUT = 5 * 60 * 1000;

export function WordViewer({ filePath }: { filePath: string }) {
  const [pdfPath, setPdfPath] = React.useState<string>();
  const [markdown, setMarkdown] = React.useState("");
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
    setMarkdown("");
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

      const markdownResponse = await documentIpc.convert({ filePath, to: "markdown" });
      if (markdownResponse?.result?.success && markdownResponse.result.data && String(markdownResponse.result.data).trim()) {
        setMarkdown(markdownResponse.result.data);
        return;
      }

      setNeedsInstall(true);
      setError(markdownResponse?.result?.error || "无法降级预览该 Word 文档。");
    } catch (err) {
      setNeedsInstall(true);
      setError(err instanceof Error ? err.message : "Word 文档预览失败。");
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

  const handleOpen = React.useCallback(async () => {
    await shellIpc.openFile(filePath);
  }, [filePath]);

  if (loading) {
    return <UnsupportedViewer title="正在加载 Word 预览" description="正在尝试 LibreOffice 与降级解析链。" />;
  }

  if (pdfPath) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-end gap-2 border-b border-border/70 px-4 py-2.5">
          <Button variant="ghost" size="sm" className="rounded-full text-xs" onClick={() => void load()}>
            刷新
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full text-xs" onClick={handleOpen}>
            用系统应用打开
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <PDFViewer filePath={pdfPath} title={filePath} />
        </div>
      </div>
    );
  }

  if (markdown) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-end gap-2 border-b border-border/70 px-4 py-2.5">
          <Button variant="ghost" size="sm" className="rounded-full text-xs" onClick={() => void load()}>
            刷新
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full text-xs" onClick={handleOpen}>
            用系统应用打开
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <MarkdownViewer content={markdown} />
        </div>
      </div>
    );
  }

  if (needsInstall) {
    return (
      <LibreOfficeInstallPrompt
        fileType="word"
        installing={installing}
        percent={installPercent}
        phase={installPhase}
        onInstall={handleInstall}
      />
    );
  }

  return <UnsupportedViewer title="Word 预览失败" description={error || "无法打开该 Word 文档。"} tone="warning" />;
}
