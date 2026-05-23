"use client";

import * as React from "react";
import {
  Globe,
  FileText,
  Image,
  ImagePlus,
  BookOpen,
  Calendar,
  GitBranch,
  Book,
  Settings,
  Star,
  Sparkles,
  Presentation,
  Bug,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface Skill {
  id: string;
  name: string;
  icon: React.ElementType;
  color: string;
  description?: string;
}

const skills: Skill[] = [
  { id: "browser", name: "browser", icon: Globe, color: "text-blue-400", description: "浏览器操作" },
  { id: "chandao-api", name: "chandao-api", icon: Bug, color: "text-red-400", description: "禅道接口" },
  { id: "docx", name: "docx", icon: FileText, color: "text-blue-500", description: "文档处理" },
  { id: "image-analysis", name: "image-analysis", icon: Image, color: "text-emerald-400", description: "图像分析" },
  { id: "image-generation", name: "image-generation", icon: ImagePlus, color: "text-pink-400", description: "图像生成" },
  { id: "jiansheku", name: "jiansheku", icon: BookOpen, color: "text-amber-400", description: "简书库" },
  { id: "leave", name: "leave", icon: Calendar, color: "text-green-400", description: "请假管理" },
  { id: "mermaid", name: "mermaid", icon: GitBranch, color: "text-cyan-400", description: "流程图" },
  { id: "moltbook", name: "moltbook", icon: Book, color: "text-orange-400", description: "Moltbook" },
  { id: "openclaw-setup", name: "openclaw-setup", icon: Settings, color: "text-slate-400", description: "环境配置" },
  { id: "pdf", name: "pdf", icon: FileText, color: "text-red-500", description: "PDF处理" },
  { id: "pptx", name: "pptx", icon: Presentation, color: "text-orange-500", description: "PPT处理" },
  { id: "PPT助手", name: "PPT助手", icon: Presentation, color: "text-amber-500", description: "PPT助手" },
  { id: "skill-creator", name: "skill-creator", icon: Wand2, color: "text-purple-400", description: "技能创建" },
  { id: "star-office-helper", name: "star-office-helper", icon: Star, color: "text-yellow-400", description: "办公助手" },
  { id: "story-roleplay", name: "story-roleplay", icon: Sparkles, color: "text-violet-400", description: "角色扮演" },
];

interface SkillGridProps {
  searchQuery?: string;
}

export function SkillGrid({ searchQuery = "" }: SkillGridProps) {
  const filteredSkills = skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="grid grid-cols-2 gap-2">
      {filteredSkills.map((skill) => {
        const Icon = skill.icon;
        return (
          <div
            key={skill.id}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5",
              "cursor-pointer transition-all duration-200",
              "hover:border-primary/30 hover:bg-accent/50 hover:shadow-sm"
            )}
          >
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background",
                "border border-border/50 transition-colors group-hover:border-primary/20"
              )}
            >
              <Icon className={cn("h-4 w-4", skill.color)} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {skill.name}
              </p>
              {skill.description && (
                <p className="truncate text-xs text-muted-foreground">
                  {skill.description}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
