import type { WorkspacePreviewContentType } from '@/types';

export const previewIpc = {
  open: (payload: { content: string; contentType: WorkspacePreviewContentType; metadata?: Record<string, unknown> }) =>
    window.agentDesktop.preview.open(payload),
  close: () => window.agentDesktop.preview.close(),
  onOpen: (callback: (payload: { content: string; contentType: WorkspacePreviewContentType; metadata?: Record<string, unknown> }) => void) =>
    window.agentDesktop.preview.onOpen(callback),
};
