import { ArrowLeft, Edit2, Bot } from 'lucide-react';
import React from 'react';
import type { InstalledAssistant } from './assistant-selection-area';
import { cn } from '@/lib/utils';

type AssistantHeaderProps = {
  assistant: InstalledAssistant;
  prompts?: string[];
  onBack: () => void;
  onEdit?: () => void;
};

const isDataUri = (str: string) => str.startsWith('data:');

const AssistantHeader: React.FC<AssistantHeaderProps> = ({
  assistant,
  prompts = [],
  onBack,
  onEdit,
}) => {
  const emojiOrAvatar = assistant.emoji?.trim() || assistant.avatar?.trim();
  const isImage = emojiOrAvatar
    ? /\.(svg|png|jpe?g|webp|gif)$/i.test(emojiOrAvatar) || isDataUri(emojiOrAvatar)
    : false;

  return (
    <div className="w-full mb-3 animate-in fade-in duration-300">
      {/* Header row */}
      <div className="flex items-center gap-3 w-full">
        {/* Back button */}
        <button
          type="button"
          onClick={onBack}
          className="flex items-center justify-center w-8 h-8 rounded-full cursor-pointer hover:bg-muted transition-colors flex-shrink-0"
        >
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </button>

        {/* Avatar */}
        <div className="flex-shrink-0">
          {emojiOrAvatar && isImage ? (
            <img
              src={isDataUri(emojiOrAvatar) ? emojiOrAvatar : emojiOrAvatar}
              alt=""
              width={28}
              height={28}
              className="object-contain"
            />
          ) : emojiOrAvatar ? (
            <span style={{ fontSize: 24, lineHeight: 1 }}>{emojiOrAvatar}</span>
          ) : (
            <Bot className="h-6 w-6 text-muted-foreground" />
          )}
        </div>

        {/* Name */}
        <span className="text-lg font-semibold truncate">
          {assistant.displayName || assistant.name}
        </span>

        {/* Edit button */}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="flex items-center justify-center w-7 h-7 rounded-full cursor-pointer hover:bg-muted transition-colors flex-shrink-0 ml-auto"
          >
            <Edit2 className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Description */}
      {assistant.description && (
        <div className="px-4 py-3 mt-2 rounded-xl text-sm text-muted-foreground leading-relaxed bg-muted/50">
          {assistant.description}
        </div>
      )}

      {/* Suggestion prompts */}
      {prompts.length > 0 && (
        <div className="mt-3">
          <div className="text-xs mb-2 text-muted-foreground/70">试试这些示例：</div>
          <div className="flex flex-wrap gap-2">
            {prompts.map((prompt, index) => (
              <button
                key={index}
                type="button"
                className={cn(
                  'px-3 py-1.5 text-sm rounded-2xl cursor-pointer transition-colors shadow-sm',
                  'bg-muted hover:bg-muted/80 text-foreground border border-border'
                )}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AssistantHeader;
