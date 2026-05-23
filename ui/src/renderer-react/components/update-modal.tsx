'use client';

import * as React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download,
  CheckCircle,
  XCircle,
  RefreshCw,
  ExternalLink,
  FolderOpen,
  Play,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  UpdateReleaseInfo,
  UpdateDownloadProgressEvent,
  AutoUpdateStatus,
} from '@/types';

type UpdateStatus = 'checking' | 'upToDate' | 'available' | 'downloading' | 'downloaded' | 'success' | 'error';

function formatSpeed(bytesPerSecond: number) {
  if (bytesPerSecond > 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
}

function formatSize(bytes: number) {
  if (bytes > 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function UpdateModal() {
  const [visible, setVisible] = React.useState(false);
  const [status, setStatus] = React.useState<UpdateStatus>('checking');
  const [updateInfo, setUpdateInfo] = React.useState<UpdateReleaseInfo | null>(null);
  const [currentVersion, setCurrentVersion] = React.useState<string>('');
  const [downloadId, setDownloadId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState({ percent: 0, speed: '', total: 0, transferred: 0 });
  const [errorMsg, setErrorMsg] = React.useState('');
  const [downloadPath, setDownloadPath] = React.useState('');
  const [releasePageUrl, setReleasePageUrl] = React.useState('');
  const [autoUpdateInfo, setAutoUpdateInfo] = React.useState<{ version: string; releaseNotes?: string } | null>(null);
  const [autoUpdateDownloadedPath, setAutoUpdateDownloadedPath] = React.useState<string | null>(null);
  const [includePrerelease] = React.useState(
    localStorage.getItem('moss.update.includePrerelease') === 'true'
  );

  const resetState = () => {
    setStatus('checking');
    setUpdateInfo(null);
    setCurrentVersion('');
    setDownloadId(null);
    setProgress({ percent: 0, speed: '', total: 0, transferred: 0 });
    setErrorMsg('');
    setDownloadPath('');
    setReleasePageUrl('');
    setAutoUpdateInfo(null);
    setAutoUpdateDownloadedPath(null);
  };

  const openReleasePage = () => {
    if (!releasePageUrl) return;
    window.open(releasePageUrl, '_blank');
  };

  const showInFolder = () => {
    const pathToShow = downloadPath || autoUpdateDownloadedPath;
    if (!pathToShow) return;
    // Can't directly show in folder from renderer, just highlight the path
    console.log('Show in folder:', pathToShow);
  };

  const checkForUpdates = async () => {
    setStatus('checking');
    try {
      // Try autoUpdate first (electron-updater with COS mirror)
      const autoRes = await window.agentDesktop.autoUpdate.check({ includePrerelease });
      if (autoRes?.success && autoRes.data?.updateInfo) {
        setAutoUpdateInfo({
          version: autoRes.data.updateInfo.version,
          releaseNotes: autoRes.data.updateInfo.releaseNotes,
        });
        const cached = await window.agentDesktop.autoUpdate.getDownloadedFilePath();
        if (cached?.success && cached.data?.path) {
          setAutoUpdateDownloadedPath(cached.data.path);
        }
      }

      // Also check manual update for more info
      const manualRes = await window.agentDesktop.update.check({ includePrerelease });
      if (manualRes?.success) {
        setCurrentVersion(manualRes.data?.currentVersion || '');
        if (manualRes.data?.latest) {
          setUpdateInfo(manualRes.data.latest);
          setReleasePageUrl(manualRes.data.latest.htmlUrl || '');
        }
      }

      if (autoRes?.success && autoRes.data?.updateInfo) {
        setStatus('available');
        return;
      }

      if (manualRes?.data?.updateAvailable && manualRes.data?.latest) {
        setStatus('available');
        return;
      }

      setStatus('upToDate');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const startAutoDownload = async () => {
    setStatus('downloading');
    try {
      const res = await window.agentDesktop.autoUpdate.download();
      if (!res?.success) {
        throw new Error(res?.msg || 'Download failed');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const startManualDownload = async () => {
    if (!updateInfo?.recommendedAsset) return;

    setStatus('downloading');
    try {
      const res = await window.agentDesktop.update.download({
        url: updateInfo.recommendedAsset.url,
        fileName: updateInfo.recommendedAsset.name,
      });
      if (!res?.success || !res.data) {
        throw new Error(res?.msg || 'Download failed');
      }

      if (res.data.downloadId === 'cached') {
        setDownloadPath(res.data.filePath);
        setStatus('success');
        return;
      }

      setDownloadId(res.data.downloadId);
      setDownloadPath(res.data.filePath);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  const quitAndInstall = async () => {
    await window.agentDesktop.autoUpdate.quitAndInstall();
  };

  const handleOpenModal = () => {
    setVisible(true);
    resetState();
    void checkForUpdates();
  };

  // Listen for update:open-modal from menu
  React.useEffect(() => {
    const off = window.agentDesktop.update.onOpenModal(handleOpenModal);
    return off;
  }, []);

  // Listen for auto-update status events
  React.useEffect(() => {
    const off = window.agentDesktop.autoUpdate.onStatus((evt: AutoUpdateStatus) => {
      if (!evt) return;

      switch (evt.status) {
        case 'checking':
          break;
        case 'available':
          setAutoUpdateInfo({
            version: evt.version || '',
            releaseNotes: evt.releaseNotes,
          });
          setStatus('available');
          setVisible(true);
          break;
        case 'not-available':
          setStatus('upToDate');
          break;
        case 'downloading':
          if (evt.progress) {
            setProgress({
              percent: Math.round(evt.progress.percent),
              speed: formatSpeed(evt.progress.bytesPerSecond),
              total: evt.progress.total,
              transferred: evt.progress.transferred,
            });
          }
          break;
        case 'downloaded':
          setStatus('downloaded');
          if (evt.downloadedFilePath) {
            setAutoUpdateDownloadedPath(evt.downloadedFilePath);
          }
          break;
        case 'error':
          setStatus('error');
          setErrorMsg(evt.error || 'Download failed');
          break;
      }
    });
    return off;
  }, []);

  // Listen for manual download progress
  React.useEffect(() => {
    const off = window.agentDesktop.update.onDownloadProgress((evt: UpdateDownloadProgressEvent) => {
      if (!evt || !downloadId || evt.downloadId !== downloadId) return;

      setProgress({
        percent: Math.round(evt.percent ?? 0),
        speed: formatSpeed(evt.bytesPerSecond ?? 0),
        total: evt.totalBytes ?? 0,
        transferred: evt.receivedBytes ?? 0,
      });

      if (evt.status === 'completed') {
        setStatus('success');
        if (evt.filePath) setDownloadPath(evt.filePath);
      } else if (evt.status === 'error' || evt.status === 'cancelled') {
        setStatus('error');
        setErrorMsg(evt.error || 'Download failed');
      }
    });
    return off;
  }, [downloadId]);

  const latestVersion = updateInfo?.version || autoUpdateInfo?.version || '';
  const hasCompatibleAsset = Boolean(updateInfo?.recommendedAsset);

  return (
    <AnimatePresence>
      {visible && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50"
            onClick={() => setVisible(false)}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2"
          >
            <div className="mx-4 rounded-2xl border border-border/80 bg-card shadow-2xl">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
                <h2 className="text-base font-semibold text-foreground">检查更新</h2>
                <button
                  onClick={() => setVisible(false)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <XCircle className="h-4 w-4" />
                </button>
              </div>

              {/* Content */}
              <div className="p-5">
                {status === 'checking' && (
                  <div className="flex flex-col items-center justify-center py-8">
                    <Loader2 className="h-10 w-10 animate-spin text-primary mb-3" />
                    <p className="text-sm text-muted-foreground">检查更新中...</p>
                  </div>
                )}

                {status === 'upToDate' && (
                  <div className="flex flex-col items-center justify-center py-8">
                    <CheckCircle className="h-12 w-12 text-green-500 mb-3" />
                    <p className="text-base font-medium text-foreground mb-1">已是最新版本</p>
                    <p className="text-xs text-muted-foreground">当前版本 {currentVersion || latestVersion || '-'}</p>
                  </div>
                )}

                {status === 'available' && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                        <Download className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">发现新版本</p>
                        <p className="text-xs text-muted-foreground">
                          {currentVersion || '-'} → <span className="text-primary font-medium">{latestVersion}</span>
                        </p>
                      </div>
                    </div>

                    {(updateInfo?.body || autoUpdateInfo?.releaseNotes) && (
                      <div className="max-h-40 overflow-y-auto rounded-lg bg-accent/50 p-3 text-xs text-muted-foreground">
                        {updateInfo?.body || autoUpdateInfo?.releaseNotes}
                      </div>
                    )}

                    <div className="flex gap-2">
                      {hasCompatibleAsset && (
                        <>
                          <Button size="sm" variant="outline" onClick={startManualDownload}>
                            <Download className="h-3.5 w-3.5 mr-1" />
                            下载
                          </Button>
                          <Button size="sm" onClick={startAutoDownload}>
                            <Play className="h-3.5 w-3.5 mr-1" />
                            下载并安装
                          </Button>
                        </>
                      )}
                      {releasePageUrl && (
                        <Button size="sm" variant="ghost" onClick={openReleasePage}>
                          <ExternalLink className="h-3.5 w-3.5 mr-1" />
                          访问发布页
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {status === 'downloading' && (
                  <div className="flex flex-col items-center justify-center py-8">
                    <Download className="h-10 w-10 text-primary mb-3 animate-bounce" />
                    <p className="text-base font-medium text-foreground mb-3">下载中...</p>
                    <div className="w-full max-w-xs">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-accent">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${progress.percent}%` }}
                        />
                      </div>
                      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                        <span>{formatSize(progress.transferred)} / {formatSize(progress.total)}</span>
                        <span className="text-primary font-medium">{progress.speed}</span>
                      </div>
                    </div>
                  </div>
                )}

                {status === 'downloaded' && (
                  <div className="flex flex-col items-center justify-center py-8">
                    <CheckCircle className="h-12 w-12 text-green-500 mb-3" />
                    <p className="text-base font-medium text-foreground mb-1">准备安装</p>
                    <p className="text-xs text-muted-foreground mb-4">更新已下载，将在退出时安装</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={showInFolder}>
                        <FolderOpen className="h-3.5 w-3.5 mr-1" />
                        显示文件
                      </Button>
                      <Button size="sm" onClick={quitAndInstall}>
                        <Play className="h-3.5 w-3.5 mr-1" />
                        立即安装
                      </Button>
                    </div>
                  </div>
                )}

                {status === 'success' && (
                  <div className="flex flex-col items-center justify-center py-8">
                    <CheckCircle className="h-12 w-12 text-green-500 mb-3" />
                    <p className="text-base font-medium text-foreground mb-1">下载完成</p>
                    <p className="max-w-xs truncate text-xs text-muted-foreground mb-4">{downloadPath}</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={showInFolder}>
                        <FolderOpen className="h-3.5 w-3.5 mr-1" />
                        显示文件
                      </Button>
                    </div>
                  </div>
                )}

                {status === 'error' && (
                  <div className="flex flex-col items-center justify-center py-8">
                    <XCircle className="h-12 w-12 text-destructive mb-3" />
                    <p className="text-base font-medium text-foreground mb-1">出错了</p>
                    <p className="max-w-xs text-center text-xs text-muted-foreground mb-4">{errorMsg}</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setVisible(false)}>
                        关闭
                      </Button>
                      <Button size="sm" onClick={() => checkForUpdates()}>
                        <RefreshCw className="h-3.5 w-3.5 mr-1" />
                        重试
                      </Button>
                      {releasePageUrl && (
                        <Button size="sm" variant="ghost" onClick={openReleasePage}>
                          <ExternalLink className="h-3.5 w-3.5 mr-1" />
                          访问发布页
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
