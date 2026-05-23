const IMAGE_MIME_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

class PasteServiceClass {
  private handlers: Map<string, (event: ClipboardEvent) => Promise<boolean>> = new Map();
  private lastFocusedComponent: string | null = null;
  private isInitialized = false;

  init() {
    if (this.isInitialized) return;
    document.addEventListener('paste', this.handleGlobalPaste);
    this.isInitialized = true;
  }

  registerHandler(componentId: string, handler: (event: ClipboardEvent) => Promise<boolean>) {
    this.handlers.set(componentId, handler);
  }

  unregisterHandler(componentId: string) {
    this.handlers.delete(componentId);
  }

  setLastFocusedComponent(componentId: string) {
    this.lastFocusedComponent = componentId;
  }

  private handleGlobalPaste = async (event: ClipboardEvent) => {
    const target = event.target as Element;
    const editableElement = target?.closest('input, textarea, [contenteditable]');
    if (editableElement instanceof HTMLInputElement || editableElement instanceof HTMLTextAreaElement) {
      return;
    }

    if (!this.lastFocusedComponent) return;
    const handler = this.handlers.get(this.lastFocusedComponent);
    if (handler) {
      const handled = await handler(event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  };

  async handlePaste(
    event: ClipboardEvent | React.ClipboardEvent,
    onFilesAdded: (files: Array<{ name: string; path: string }>) => void,
    onTextPaste?: (text: string) => void
  ): Promise<boolean> {
    event.stopPropagation();

    const clipboardText = event.clipboardData?.getData('text');
    const files = event.clipboardData?.files;

    if (files && files.length > 0) {
      const fileList: Array<{ name: string; path: string }> = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = (file as File & { path?: string }).path;

        if (filePath && file.type.startsWith('image/')) {
          fileList.push({ name: file.name, path: filePath });
        } else if (file.type.startsWith('image/')) {
          const ext = IMAGE_MIME_MAP[file.type] || '.png';
          const timeStr = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
          const fileName = `pasted_image_${timeStr}${ext}`;

          try {
            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            const tempPath = await window.agentDesktop.fs.createTempFile(fileName);
            if (tempPath) {
              await window.agentDesktop.fs.writeFile(tempPath, Array.from(uint8Array));
              fileList.push({ name: fileName, path: tempPath });
            }
          } catch (error) {
            console.error('Failed to save pasted image:', error);
          }
        }
      }

      if (fileList.length > 0) {
        onFilesAdded(fileList);
        return true;
      }
    }

    if (clipboardText && (!files || files.length === 0) && onTextPaste) {
      onTextPaste(clipboardText);
      return true;
    }

    return false;
  }

  destroy() {
    if (this.isInitialized) {
      document.removeEventListener('paste', this.handleGlobalPaste);
      this.handlers.clear();
      this.lastFocusedComponent = null;
      this.isInitialized = false;
    }
  }
}

export const pasteService = new PasteServiceClass();
