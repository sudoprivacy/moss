"use client";

import * as React from "react";
import { X, FileText, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];

function isImageFile(path: string): boolean {
  const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
  return IMAGE_EXTS.includes(ext);
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

interface FilePreviewProps {
  path: string;
  onRemove?: () => void;
  readonly?: boolean;
}

export function FilePreview({ path, onRemove, readonly = false }: FilePreviewProps) {
  const isImage = isImageFile(path);
  const fileName = path.split(/[\\/]/).pop() || '';
  const fileExt = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() || '' : '';
  const [imageUrl, setImageUrl] = React.useState<string>('');
  const [fileSize, setFileSize] = React.useState<string>('');

  React.useEffect(() => {
    window.agentDesktop.fs.getFileMetadata(path).then((metadata: any) => {
      if (metadata?.size) setFileSize(formatFileSize(metadata.size));
    });

    if (isImage) {
      window.agentDesktop.fs.getImageBase64(path).then((base64: string | null) => {
        if (base64) setImageUrl(base64);
      });
    }
  }, [path, isImage]);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove?.();
  };

  if (isImage) {
    return (
      <div className="relative inline-block">
        <div className="overflow-hidden rounded-lg border border-border/70">
          {imageUrl ? (
            <img src={imageUrl} alt={fileName} className="h-16 w-16 object-cover cursor-pointer" />
          ) : (
            <div className="h-16 w-16 bg-muted flex items-center justify-center">
              <ImageIcon className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
        </div>
        {!readonly && onRemove && (
          <button
            onClick={handleRemove}
            className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-background border border-border flex items-center justify-center shadow-sm hover:shadow-md transition-shadow"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative inline-block">
      <div className="h-16 flex items-center gap-3 px-3 rounded-lg border border-border/70 bg-card">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-muted">
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-medium truncate max-w-[150px]">{fileName}</span>
          <span className="text-xs text-muted-foreground">
            {fileExt}{fileSize ? `: ${fileSize}` : ''}
          </span>
        </div>
      </div>
      {!readonly && onRemove && (
        <button
          onClick={handleRemove}
          className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-background border border-border flex items-center justify-center shadow-sm hover:shadow-md transition-shadow"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
