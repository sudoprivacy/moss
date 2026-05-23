"use client";

import * as React from "react";

const WorkspacePathContext = React.createContext<string>("");

export function WorkspacePathProvider({
  workspace,
  children,
}: {
  workspace: string;
  children: React.ReactNode;
}) {
  return React.createElement(WorkspacePathContext.Provider, { value: workspace }, children);
}

export function useWorkspacePath(): string {
  return React.useContext(WorkspacePathContext);
}