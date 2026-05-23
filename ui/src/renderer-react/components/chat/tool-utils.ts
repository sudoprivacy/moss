"use client";

import type {
  ToolResultRenderMessage,
  ToolUseRenderMessage,
} from "@/lib/agent-transcript";

export type ToolKind =
  | "bash"
  | "read"
  | "search"
  | "write"
  | "edit"
  | "agent"
  | "web"
  | "db"
  | "other";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateMiddle(text: string, max = 72): string {
  if (text.length <= max) return text;
  const side = Math.max(8, Math.floor((max - 1) / 2));
  return `${text.slice(0, side)}…${text.slice(-side)}`;
}

export function formatLocator(value?: string): string | undefined {
  if (!value) return undefined;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const path = url.pathname === "/" ? "" : url.pathname;
      return truncateMiddle(`${url.host}${path}`, 72);
    } catch {
      return truncateMiddle(value, 72);
    }
  }

  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length > 3) {
    return `…/${parts.slice(-3).join("/")}`;
  }
  return truncateMiddle(value, 72);
}

export function quoteValue(value?: string): string | undefined {
  if (!value) return undefined;
  return `"${truncate(compactWhitespace(value), 64)}"`;
}

export function getInputRecord(toolCall: ToolUseRenderMessage): Record<string, unknown> {
  return isRecord(toolCall.input) ? toolCall.input : {};
}

export function getInputString(
  input: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function getToolKind(toolName: string, input?: unknown): ToolKind {
  const rawName = String(toolName || "").toLowerCase();
  const record = isRecord(input) ? input : {};
  const hasOldString = typeof record.old_string === "string";
  const hasNewString = typeof record.new_string === "string";

  if (rawName.includes("agent")) return "agent";
  if (rawName.includes("web") || rawName.includes("fetch") || rawName.includes("browser")) return "web";
  if (rawName.includes("sql") || rawName.includes("db")) return "db";
  if (rawName.includes("read")) return "read";
  if (rawName.includes("grep") || rawName.includes("glob") || rawName.includes("search")) return "search";
  if (rawName.includes("write")) return "write";
  if (rawName.includes("edit") || rawName.includes("patch") || rawName.includes("multi_edit") || (hasOldString && hasNewString)) return "edit";
  if (rawName.includes("bash") || rawName.includes("exec") || rawName.includes("command")) return "bash";
  return "other";
}

export function getToolFilePath(toolCall: ToolUseRenderMessage): string | undefined {
  const input = getInputRecord(toolCall);
  return getInputString(input, ["file_path", "path", "filePath", "notebook_path"]);
}

export function getToolCommand(toolCall: ToolUseRenderMessage): string | undefined {
  return getInputString(getInputRecord(toolCall), ["command", "cmd"]);
}

export function getToolPatternOrQuery(toolCall: ToolUseRenderMessage): string | undefined {
  const input = getInputRecord(toolCall);
  return getInputString(input, ["pattern", "query", "prompt"]);
}

export function getToolUrl(toolCall: ToolUseRenderMessage): string | undefined {
  return getInputString(getInputRecord(toolCall), ["url"]);
}

export function inferLanguage(
  filePath?: string,
  fallback?: string,
): string {
  const ext = (filePath || "").split(".").pop()?.toLowerCase() || fallback?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    css: "css",
    html: "html",
    htm: "html",
    xml: "xml",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    diff: "diff",
  };
  return langMap[ext] || fallback || "text";
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry: any) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          if (typeof entry.text === "string") return entry.text;
          if (typeof entry.content === "string") return entry.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return String(content ?? "");
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}

export function firstNonEmptyLine(text?: string): string | undefined {
  if (!text) return undefined;
  return text
    .split("\n")
    .map((line) => stripAnsi(line).trim())
    .find(Boolean);
}

export function summarizeToolResult(
  result?: ToolResultRenderMessage,
): string | undefined {
  if (!result) return undefined;
  const shell = extractShellResult(result.rawContent);
  const text = compactWhitespace(
    firstNonEmptyLine(shell?.stderr || shell?.stdout || result.content) || "",
  );
  return text ? truncate(text, 96) : undefined;
}

export function extractShellResult(
  rawContent: unknown,
):
  | {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    }
  | undefined {
  if (!isRecord(rawContent)) return undefined;
  const stdout = typeof rawContent.stdout === "string" ? rawContent.stdout : undefined;
  const stderr = typeof rawContent.stderr === "string" ? rawContent.stderr : undefined;
  const exitCode =
    typeof rawContent.exitCode === "number"
      ? rawContent.exitCode
      : typeof rawContent.exit_code === "number"
        ? rawContent.exit_code
        : undefined;

  if (!stdout && !stderr && exitCode === undefined) return undefined;
  return { stdout, stderr, exitCode };
}

export function extractToolFilePayload(rawContent: unknown): {
  filePath?: string;
  filePaths?: string[];
  fileKind?: string;
} | undefined {
  if (!isRecord(rawContent)) return undefined;

  const filePath = typeof rawContent.filePath === "string" ? rawContent.filePath : undefined;
  const fileKind = typeof rawContent.fileKind === "string" ? rawContent.fileKind : undefined;
  const filePaths = Array.isArray(rawContent.filePaths)
    ? rawContent.filePaths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;

  if (!filePath && !filePaths?.length && !fileKind) return undefined;
  return { filePath, filePaths, fileKind };
}

export function summarizeToolLabel(toolCall: ToolUseRenderMessage): string {
  const kind = getToolKind(toolCall.toolName, toolCall.input);
  const filePath = getToolFilePath(toolCall);
  const pattern = getToolPatternOrQuery(toolCall);
  const command = getToolCommand(toolCall);
  const url = getToolUrl(toolCall);
  const input = getInputRecord(toolCall);

  switch (kind) {
    case "read":
      return formatLocator(filePath) || toolCall.displayName;
    case "search":
      return quoteValue(pattern) || formatLocator(filePath) || toolCall.displayName;
    case "write":
    case "edit":
      return formatLocator(filePath) || toolCall.displayName;
    case "bash":
      return truncate(compactWhitespace(command || toolCall.inputText || toolCall.displayName), 96);
    case "web":
      return formatLocator(url) || quoteValue(pattern) || toolCall.displayName;
    case "agent":
      return truncate(
        compactWhitespace(
          getInputString(input, ["description", "prompt", "query"]) || toolCall.displayName,
        ),
        96,
      );
    case "db":
      return truncate(compactWhitespace(pattern || toolCall.displayName), 96);
    default:
      return truncate(compactWhitespace(toolCall.inputText || toolCall.displayName), 96);
  }
}
