"use client";

import * as React from "react";
import { Bot, Loader2, Users } from "lucide-react";
import type { CoordinatorTask, ExecutionSummary } from "@/types";

export function ExecutionPetPanel({
  executions,
  onFocus,
}: {
  executions: ExecutionSummary[];
  onFocus: (executionId: string) => void;
}) {
  // Show all sub-agents (both running and completed)
  if (executions.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-wrap gap-2"
      style={{ maxWidth: "280px" }}
    >
      {executions.map((exec) => (
        <button
          key={exec.id}
          onClick={() => onFocus(exec.id)}
          title={exec.originalPrompt.slice(0, 80)}
          className="group relative"
        >
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full border-2 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.5)] transition-all hover:scale-110 hover:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]"
            style={{
              background: exec.busy
                ? "linear-gradient(135deg, #3b82f6, #8b5cf6)"
                : "linear-gradient(135deg, #22c55e, #16a34a)",
              borderColor: exec.busy ? "rgba(139, 92, 246, 0.5)" : "rgba(34, 197, 94, 0.5)",
              opacity: exec.busy ? 1 : 0.7,
            }}
          >
            {exec.busy ? (
              <Loader2 className="h-5 w-5 text-white animate-spin" />
            ) : (
              <Bot className="h-5 w-5 text-white" />
            )}
          </div>
          {/* Tooltip */}
          <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-black/80 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none">
            {exec.originalPrompt.slice(0, 50)}
            {exec.originalPrompt.length > 50 ? "..." : ""}
          </div>
        </button>
      ))}
    </div>
  );
}

export function CoordinatorTaskPanel({
  tasks,
}: {
  tasks: CoordinatorTask[];
}) {
  if (tasks.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-50 flex flex-wrap gap-2"
      style={{ maxWidth: "320px" }}
    >
      <div className="flex items-center gap-1 mb-1 text-xs text-gray-400">
        <Users className="h-3 w-3" />
        <span>Coordinator Workers</span>
      </div>
      {tasks.map((task) => (
        <div
          key={task.id}
          className="group relative"
        >
          <div
            className="flex h-10 w-10 items-center justify-center rounded-full border-2 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.5)] transition-all"
            style={{
              background: task.isIdle
                ? "linear-gradient(135deg, #6b7280, #4b5563)"
                : "linear-gradient(135deg, #8b5cf6, #6366f1)",
              borderColor: task.isIdle ? "rgba(107, 114, 128, 0.5)" : "rgba(139, 92, 246, 0.5)",
              opacity: task.isIdle ? 0.6 : 1,
            }}
            title={task.description || task.name}
          >
            {task.isIdle ? (
              <Bot className="h-4 w-4 text-white" />
            ) : (
              <Loader2 className="h-4 w-4 text-white animate-spin" />
            )}
          </div>
          {/* Task name tooltip */}
          <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-black/80 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none">
            {task.name}
            {task.isIdle ? " (idle)" : " (working)"}
          </div>
        </div>
      ))}
    </div>
  );
}
