import type { PreviewHistoryTarget } from '@/types';

export const previewHistoryIpc = {
  list: (payload: { target: PreviewHistoryTarget }) => window.agentDesktop.previewHistory.list(payload),
  save: (payload: { target: PreviewHistoryTarget; content: string }) => window.agentDesktop.previewHistory.save(payload),
  getContent: (payload: { target: PreviewHistoryTarget; snapshotId: string }) =>
    window.agentDesktop.previewHistory.getContent(payload),
};
