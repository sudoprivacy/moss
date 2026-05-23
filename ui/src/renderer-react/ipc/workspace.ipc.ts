import type { WorkspacePreviewData } from '@/types';

export const workspaceIpc = {
  writeFile: (payload: { sessionId: string; filePath: string; content: string }) =>
    window.agentDesktop.workspace.writeFile(payload) as Promise<WorkspacePreviewData>,
};
