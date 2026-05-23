export const documentIpc = {
  convert: (payload: { filePath: string; to: 'libreoffice-pdf' | 'markdown' | 'word-html' | 'excel-json' | 'ppt-json' | 'pptx-arraybuffer' }) =>
    window.agentDesktop.document.convert(payload),
  libreOffice: {
    isAvailable: () => window.agentDesktop.document.libreOffice.isAvailable(),
  },
};
