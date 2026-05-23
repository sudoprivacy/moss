"use client";

import * as React from "react";
import { Check, CircleAlert, Loader2, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageList } from "@/components/chat/message-list";
import { cn } from "@/lib/utils";
import type { WorkerThread } from "@/lib/agent-transcript";

const WORKER_ANIMALS = [
  { emoji: "🦊" },
  { emoji: "🦦" },
  { emoji: "🐸" },
  { emoji: "🦆" },
  { emoji: "🐱" },
];

function getAnimal(index: number) {
  return WORKER_ANIMALS[index % WORKER_ANIMALS.length];
}

function WorkerStatusIcon({ status }: { status: WorkerThread["status"] }) {
  if (status === "running" || status === "queued") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  }
  if (status === "completed") {
    return <Check className="h-3.5 w-3.5 text-emerald-500" />;
  }
  return <CircleAlert className="h-3.5 w-3.5 text-destructive" />;
}

function WorkerPill({
  thread,
  animalIndex,
  isActive,
  onToggle,
}: {
  thread: WorkerThread;
  animalIndex: number;
  isActive: boolean;
  onToggle: () => void;
}) {
  const isRunning = thread.status === "running" || thread.status === "queued";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border text-sm transition-all",
        isActive
          ? "border-primary/50 bg-card"
          : "border-border/70 bg-card/82 hover:border-primary/30",
      )}
      title={`${thread.title} · ${thread.status}`}
    >
      <span className={cn(isRunning && "animate-bounce")}>
        {getAnimal(animalIndex).emoji}
      </span>
    </button>
  );
}

export function WorkerThreadPanel({
  threads,
  archivedRounds,
  activeThreadId,
  onToggleThread,
}: {
  threads: WorkerThread[];
  archivedRounds: WorkerThread[][];
  activeThreadId: string | null;
  onToggleThread: (threadId: string | null) => void;
}) {
  const displayRounds = React.useMemo(() => {
    const rounds = archivedRounds
      .filter((round) => round.length > 0)
      .map((round, index) => ({
        roundNumber: index + 1,
        threads: round,
        completedCount: round.filter(
          (thread) => thread.status === "completed" || thread.status === "failed",
        ).length,
      }));

    if (threads.length > 0) {
      rounds.push({
        roundNumber: rounds.length + 1,
        threads,
        completedCount: threads.filter(
          (thread) => thread.status === "completed" || thread.status === "failed",
        ).length,
      });
    }

    return [...rounds].reverse();
  }, [archivedRounds, threads]);

  const allThreads = React.useMemo(
    () => displayRounds.flatMap((round) => round.threads),
    [displayRounds],
  );
  const activeThread = allThreads.find((t) => t.id === activeThreadId) || null;
  const activeThreadAnimalIndex = React.useMemo(() => {
    if (!activeThreadId) return 0;
    for (const round of displayRounds) {
      const index = round.threads.findIndex((thread) => thread.id === activeThreadId);
      if (index >= 0) return index;
    }
    return 0;
  }, [activeThreadId, displayRounds]);
  if (allThreads.length === 0) return null;

  return (
    <div className="space-y-2">
      {/* Active worker detail panel */}
      {activeThread && (
        <div className="flex max-h-[50vh] min-h-0 flex-col overflow-hidden rounded-[24px] border border-border/80 bg-card/96 shadow-[0_24px_72px_-48px_rgba(0,0,0,0.75)] backdrop-blur">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/70 px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-primary/25 to-primary/8 text-xs">
                  {getAnimal(activeThreadAnimalIndex).emoji}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{activeThread.title}</h3>
                    <WorkerStatusIcon status={activeThread.status} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    {activeThread.agentId ? <span className="font-mono">{activeThread.agentId}</span> : null}
                  </div>
                </div>
              </div>
              {activeThread.prompt ? (
                <p className="mt-2 max-w-[720px] whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                  {activeThread.prompt}
                </p>
              ) : null}
              {activeThread.resultText ? (
                <div className="mt-2 max-w-[720px] rounded-xl border border-border/70 bg-background/70 px-2 py-2">
                  <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Output
                  </div>
                  <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                    {activeThread.resultText}
                  </p>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onToggleThread(null)}
              className="rounded-full border border-border/70 bg-background/70 p-1.5 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="关闭 worker transcript"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <ScrollArea className="h-[30vh] min-h-[120px] flex-1">
            <div className="bg-[radial-gradient(circle_at_top_left,rgba(58,191,129,0.08),transparent_22%),var(--background)] py-1">
              <MessageList
                messages={activeThread.messages}
                emptyState={(
                  <div className="rounded-xl border border-dashed border-border/70 bg-card/50 px-3 py-4 text-xs text-muted-foreground">
                    该 worker 还没有可展示的消息。
                  </div>
                )}
              />
            </div>
          </ScrollArea>
        </div>
      )}

      <div className="rounded-[20px] border border-border/80 bg-card/88 px-3 py-1.5 shadow-[0_18px_48px_-36px_rgba(0,0,0,0.68)] backdrop-blur">
        <div className="max-h-[72px] space-y-1 overflow-y-auto pr-1">
          {displayRounds.map((round) => (
            <div key={`round-${round.roundNumber}`} className="flex items-center gap-2">
              <span className="shrink-0 rounded-full border border-border/70 bg-background/75 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {round.completedCount}/{round.threads.length}
              </span>
              <div className="min-w-0 overflow-x-auto">
                <div className="flex w-max items-center gap-1.5">
                  {round.threads.map((thread, index) => (
                    <WorkerPill
                      key={thread.id}
                      thread={thread}
                      animalIndex={index}
                      isActive={thread.id === activeThreadId}
                      onToggle={() => onToggleThread(thread.id === activeThreadId ? null : thread.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
