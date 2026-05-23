export function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  return `file://${encodeURI(normalized)}`;
}

export function basename(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

export function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index + 1) : normalized;
}

export function buildHtmlDocument(content: string, filePath: string): string {
  const baseHref = toFileUrl(dirname(filePath));
  if (/<base\s/i.test(content)) return content;
  if (/<head>/i.test(content)) {
    return content.replace(/<head>/i, `<head><base href="${baseHref}">`);
  }
  if (/<html>/i.test(content)) {
    return content.replace(/<html>/i, `<html><head><base href="${baseHref}"></head>`);
  }
  return `<head><base href="${baseHref}"></head>${content}`;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
