"use client";

import * as React from 'react';
import { getCompanion, isBuddyEnabled, saveCompanion, setBuddyEnabled } from './buddy-companion';
import { renderSprite, spriteFrameCount } from './buddy-sprites';
import { RARITY_STARS, RARITY_COLORS } from './buddy-types';
import type { Companion, StatName } from './buddy-types';
import { cn } from '@/lib/utils';
import { Bot, Loader2 } from 'lucide-react';

const TICK_MS = 500;

const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0];

function getFrame(species: string, tick: number): number {
  const seq = IDLE_SEQUENCE;
  const idx = tick % seq.length;
  const frame = seq[idx];
  if (frame === -1) return 0; // blink on frame 0
  return frame;
}

const BUDDY_POSITION_KEY = 'ui.buddyPosition';

function getStoredPosition(): { x: number; y: number } {
  try {
    const stored = localStorage.getItem(BUDDY_POSITION_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return { x: 16, y: window.innerHeight - 120 };
}

function savePosition(pos: { x: number; y: number }) {
  localStorage.setItem(BUDDY_POSITION_KEY, JSON.stringify(pos));
}

export function BuddyCompanion({
  compact = false,
}: {
  compact?: boolean;
}) {
  const [tick, setTick] = React.useState(0);
  const [showCard, setShowCard] = React.useState(false);
  const [pos, setPos] = React.useState(getStoredPosition);
  const [isDragging, setIsDragging] = React.useState(false);
  const [dragStart, setDragStart] = React.useState({ x: 0, y: 0 });

  // Re-read from localStorage every render to pick up changes from BuddySummary
  const companion = isBuddyEnabled() ? getCompanion() : null;

  React.useEffect(() => {
    if (!companion) return;
    const timer = window.setInterval(() => {
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [companion]);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Don't drag if clicking the close button inside the stats card
    if ((e.target as HTMLElement).closest('.buddy-card-close')) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - pos.x, y: e.clientY - pos.y });
    e.preventDefault();
  };

  React.useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      setPos({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    };

    const onMouseUp = () => {
      setIsDragging(false);
      savePosition(pos);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging, dragStart, pos]);

  if (!companion) return null;

  const frame = getFrame(companion.species, tick);
  const lines = renderSprite(companion, frame);
  const rarityColor = RARITY_COLORS[companion.rarity];

  if (compact) {
    return (
      <div
        className="fixed z-50 cursor-move select-none"
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={handleMouseDown}
      >
        <button
          onClick={() => setShowCard(!showCard)}
          className="relative flex h-10 w-10 items-center justify-center rounded-full border-2 shadow-md transition-transform hover:scale-110"
          style={{
            background: `linear-gradient(135deg, ${rarityColor}40, ${rarityColor}20)`,
            borderColor: rarityColor,
          }}
          title={companion.name}
        >
          <pre className="text-[6px] leading-none text-foreground">
            {lines.slice(0, 3).join('\n')}
          </pre>
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed z-50 cursor-move select-none"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={handleMouseDown}
    >
      <button
        onClick={() => setShowCard(!showCard)}
        className="group relative flex flex-col items-center gap-1 rounded-xl border border-border/60 bg-card/80 px-4 py-3 shadow-md transition-all hover:bg-card"
      >
        {/* Sprite */}
        <pre className={cn(
          "text-[10px] leading-none font-mono",
          companion.shiny && "animate-pulse"
        )}>
          {lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </pre>
        {/* Name and rarity */}
        <div className="mt-2 text-center">
          <div className="text-xs font-medium text-foreground">{companion.name}</div>
          <div className="text-[10px]" style={{ color: rarityColor }}>
            {RARITY_STARS[companion.rarity]}
          </div>
        </div>
      </button>

      {/* Stats card */}
      {showCard && (
        <div className="absolute top-full left-1/2 z-50 mt-2 w-64 -translate-x-1/2 rounded-2xl border border-border/80 bg-card/95 p-4 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">{companion.name}</div>
              <div className="text-xs" style={{ color: rarityColor }}>
                {RARITY_STARS[companion.rarity]} {companion.rarity}
                {companion.shiny && ' ✨'}
              </div>
            </div>
            <button
              onClick={() => setShowCard(false)}
              className="buddy-card-close text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 text-xs text-muted-foreground italic">
            "{companion.personality}"
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1 text-center">
            {(Object.entries(companion.stats) as [StatName, number][]).map(([stat, value]) => (
              <div key={stat} className="flex flex-col items-center">
                <div className="text-[8px] uppercase tracking-wider text-muted-foreground">{stat.slice(0, 3)}</div>
                <div
                  className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold"
                  style={{
                    background: `${rarityColor}30`,
                    color: rarityColor,
                  }}
                >
                  {value}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>出生：{new Date(companion.hatchedAt).toLocaleDateString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Companion summary for settings display
export function BuddySummary() {
  const [companion, setCompanion] = React.useState<Companion | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState('');
  const [personality, setPersonality] = React.useState('');
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    const c = getCompanion();
    setCompanion(c || null);
    if (c) {
      setName(c.name);
      setPersonality(c.personality);
    }
  }, []);

  React.useEffect(() => {
    if (!companion) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => window.clearInterval(timer);
  }, [companion]);

  if (!companion) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-4">
        <Bot className="h-8 w-8 text-muted-foreground" />
        <div className="flex-1">
          <div className="text-sm font-medium text-foreground">Buddy 伴侣精灵</div>
          <div className="text-xs text-muted-foreground">点击下方按钮孵化你的专属宠物</div>
        </div>
        <button
          onClick={() => {
            const c = saveCompanion({ name: 'Buddy', personality: '活泼可爱的小家伙' });
            setCompanion(c);
            setName(c.name);
            setPersonality(c.personality);
          }}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
        >
          孵化宠物
        </button>
      </div>
    );
  }

  const frame = getFrame(companion.species, tick);
  const lines = renderSprite(companion, frame);
  const rarityColor = RARITY_COLORS[companion.rarity];

  if (editing) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/60 p-4">
        <div className="text-sm font-medium text-foreground">编辑 Buddy</div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="宠物名字"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
        />
        <textarea
          value={personality}
          onChange={(e) => setPersonality(e.target.value)}
          placeholder="宠物个性描述"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          rows={2}
        />
        <div className="flex gap-2">
          <button
            onClick={() => {
              const updated = saveCompanion({ name, personality });
              setCompanion(updated);
              setEditing(false);
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
          >
            保存
          </button>
          <button
            onClick={() => setEditing(false)}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-4">
      <pre className={cn(
        "text-[10px] leading-none font-mono",
        companion.shiny && "animate-pulse"
      )}>
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </pre>
      <div className="flex-1">
        <div className="text-sm font-medium text-foreground">{companion.name}</div>
        <div className="text-xs" style={{ color: rarityColor }}>
          {RARITY_STARS[companion.rarity]} {companion.rarity}
          {companion.shiny && ' ✨'}
        </div>
        <div className="mt-1 text-xs text-muted-foreground italic">
          "{companion.personality}"
        </div>
      </div>
      <button
        onClick={() => setEditing(true)}
        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        编辑
      </button>
    </div>
  );
}
