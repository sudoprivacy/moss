import { Bot } from 'lucide-react';
import React from 'react';
import { cn } from '@/lib/utils';

export type InstalledAssistant = {
  name: string;
  displayName: string;
  description: string;
  avatar: string;
  emoji: string;
  category: string;
  categories: string[];
  version: string;
  source: string;
  isBuiltin: boolean;
  isHubInstalled: boolean;
  tag: string;
  enabled: boolean;
  skills: string[];
  enabledSkills: string[];
};

type AssistantSelectionAreaProps = {
  assistants: InstalledAssistant[];
  selectedAssistant: InstalledAssistant | null;
  onSelectAssistant: (assistant: InstalledAssistant) => void;
};

const isDataUri = (str: string) => str.startsWith('data:');

const AssistantPill: React.FC<{
  assistant: InstalledAssistant;
  isSelected: boolean;
  onClick: () => void;
}> = ({ assistant, isSelected, onClick }) => {
  const emojiOrAvatar = assistant.emoji?.trim() || assistant.avatar?.trim();
  const isImage = emojiOrAvatar
    ? /\.(svg|png|jpe?g|webp|gif)$/i.test(emojiOrAvatar) || isDataUri(emojiOrAvatar)
    : false;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 group flex items-center gap-2 px-4 rounded-full border bg-transparent cursor-pointer transition-all select-none',
        'hover:bg-muted',
        isSelected
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground'
      )}
    >
      {emojiOrAvatar ? (
        isImage ? (
          <img
            src={isDataUri(emojiOrAvatar) ? emojiOrAvatar : emojiOrAvatar}
            alt=""
            width={14}
            height={14}
            className="object-contain flex-shrink-0"
          />
        ) : (
          <span style={{ fontSize: 14, lineHeight: 1 }}>{emojiOrAvatar}</span>
        )
      ) : (
        <Bot className="h-3.5 w-3.5 flex-shrink-0" />
      )}
      <span className="text-sm">{assistant.displayName || assistant.name}</span>
    </button>
  );
};

export const AssistantSelectionArea: React.FC<AssistantSelectionAreaProps> = ({
  assistants,
  selectedAssistant,
  onSelectAssistant,
}) => {
  if (!assistants || assistants.length === 0) {
    return null;
  }

  const sortedAssistants = assistants
    .filter((a) => a.enabled !== false)
    .sort((a, b) => {
      if (a.name === 'cowork') return -1;
      if (b.name === 'cowork') return 1;
      return 0;
    });

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {sortedAssistants.map((assistant) => (
        <AssistantPill
          key={assistant.name}
          assistant={assistant}
          isSelected={selectedAssistant?.name === assistant.name}
          onClick={() => onSelectAssistant(assistant)}
        />
      ))}
    </div>
  );
};
