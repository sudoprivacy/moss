import * as React from 'react';
import {
  Bot,
  Check,
  FileText,
  Image as ImageIcon,
  Link2,
  MessageSquare,
  Monitor,
  MoonStar,
  Palette,
  Search,
  Shield,
  Sparkles,
  SunMedium,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { BuddySummary } from '@/components/buddy';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useAdapterConfig } from '@/lib/adapter-config';
import { PRESET_THEMES } from '@/theme/presets';
import type { DesktopSettings } from '../types';

type ThemeMode = 'dark' | 'light' | 'system';
type SectionId = 'connection' | 'permission' | 'text-model' | 'image-model' | 'prompt' | 'im-adapter' | 'buddy' | 'appearance';

type SettingsViewProps = {
  settingsDraft: DesktopSettings | null;
  setSettingsDraft: React.Dispatch<React.SetStateAction<DesktopSettings | null>>;
  settingsNotice: string;
  autoSaveSettings: (key: keyof DesktopSettings, value: DesktopSettings[keyof DesktopSettings]) => Promise<void>;
  autoSaveImageSettings: (image: DesktopSettings['image']) => Promise<void>;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  cssThemeId: string;
  setCssThemeId: (id: string) => void;
  buddyEnabled: boolean;
  onBuddyEnabledChange: (enabled: boolean) => void;
};

type SettingsSectionDefinition = {
  id: SectionId;
  title: string;
  icon: LucideIcon;
  iconGradientClassName: string;
  keywords: string[];
};

type SettingsSectionProps = {
  id: SectionId;
  title: string;
  children: React.ReactNode;
  sectionRef: (element: HTMLElement | null) => void;
};

type SettingsGroupProps = {
  children: React.ReactNode;
  className?: string;
};

type SettingsRowProps = {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  stacked?: boolean;
  controlClassName?: string;
  className?: string;
};

type ToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
};

type SectionNavItemProps = {
  section: SettingsSectionDefinition;
  active: boolean;
  onClick: () => void;
  compact?: boolean;
};

type ThemeModeButtonProps = {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
};

type ThemePresetButtonProps = {
  selected: boolean;
  themeId: string;
  themeName: string;
  onClick: () => void;
};

const DEFAULT_IMAGE_SETTINGS: DesktopSettings['image'] = {
  provider: 'minimax',
  url: '',
  apiKey: '',
  model: '',
};

const SECTION_DEFINITIONS: SettingsSectionDefinition[] = [
  {
    id: 'connection',
    title: '连接',
    icon: Link2,
    iconGradientClassName: 'from-sky-400 to-blue-600',
    keywords: ['连接', 'connection', 'remote', 'server', 'workspace', '认证', 'credential', 'url'],
  },
  {
    id: 'permission',
    title: '权限',
    icon: Shield,
    iconGradientClassName: 'from-violet-400 to-fuchsia-600',
    keywords: ['权限', 'permission', 'allow', 'turns', 'thinking', '轮次'],
  },
  {
    id: 'text-model',
    title: '文本模型',
    icon: Sparkles,
    iconGradientClassName: 'from-emerald-400 to-teal-600',
    keywords: ['文本模型', 'model', 'api', 'key', 'anthropic', 'claude', 'url'],
  },
  {
    id: 'image-model',
    title: '图片模型',
    icon: ImageIcon,
    iconGradientClassName: 'from-pink-400 to-rose-600',
    keywords: ['图片模型', 'image', 'provider', 'api', 'key', 'url'],
  },
  {
    id: 'prompt',
    title: '系统提示',
    icon: FileText,
    iconGradientClassName: 'from-cyan-400 to-sky-600',
    keywords: ['prompt', '系统提示', 'append', 'instruction'],
  },
  {
    id: 'im-adapter',
    title: 'IM 接入',
    icon: MessageSquare,
    iconGradientClassName: 'from-emerald-400 to-green-600',
    keywords: ['IM', '接入', 'im', 'adapter', '飞书', 'feishu', 'telegram', '电报', '机器人', 'bot', '即时通讯'],
  },
  {
    id: 'buddy',
    title: 'Buddy',
    icon: Bot,
    iconGradientClassName: 'from-rose-400 to-orange-500',
    keywords: ['buddy', 'pet', 'companion', '伴侣', '宠物'],
  },
  {
    id: 'appearance',
    title: '外观',
    icon: Palette,
    iconGradientClassName: 'from-amber-400 to-orange-600',
    keywords: ['appearance', 'theme', 'background', '外观', '主题'],
  },
];

const FIELD_CLASS_NAME =
  'h-9 rounded-xl border-sidebar-border bg-sidebar-accent/70 text-[13px] text-sidebar-foreground shadow-none placeholder:text-sidebar-foreground/45';
const SELECT_CLASS_NAME =
  'h-9 w-full rounded-xl border border-sidebar-border bg-sidebar-accent/70 px-3 text-[13px] text-sidebar-foreground shadow-none outline-none transition focus:border-sidebar-ring focus:ring-4 focus:ring-sidebar-ring/15';

const THEME_PREVIEW_STYLES: Record<string, React.CSSProperties> = {
  default: {
    background: 'linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%)',
  },
  'grid-theme': {
    backgroundColor: '#f8fafc',
    backgroundImage:
      'linear-gradient(rgba(15, 23, 42, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(15, 23, 42, 0.08) 1px, transparent 1px)',
    backgroundSize: '14px 14px',
  },
  'dot-theme': {
    backgroundColor: '#f8fafc',
    backgroundImage: 'radial-gradient(rgba(15, 23, 42, 0.14) 1.1px, transparent 1.1px)',
    backgroundSize: '12px 12px',
  },
  'gradient-theme': {
    background: 'linear-gradient(135deg, #eefaf5 0%, #d8ebe7 100%)',
  },
};

function Surface({ children, className }: SettingsGroupProps) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[20px] border border-sidebar-border bg-sidebar-accent/58 text-sidebar-foreground shadow-none backdrop-blur-xl',
        className,
      )}
    >
      {children}
    </div>
  );
}

function SettingsSection({ id, title, children, sectionRef }: SettingsSectionProps) {
  return (
    <section id={id} ref={sectionRef} className="scroll-mt-6">
      <div className="mb-3 px-1">
        <p className="text-[13px] font-medium text-muted-foreground">
          {title}
        </p>
      </div>
      {children}
    </section>
  );
}

function SettingsGroup({ children, className }: SettingsGroupProps) {
  return (
    <Surface className={cn('divide-y divide-sidebar-border', className)}>
      {children}
    </Surface>
  );
}

function SettingsRow({
  title,
  description,
  children,
  stacked = false,
  controlClassName,
  className,
}: SettingsRowProps) {
  if (stacked) {
    return (
      <div className={cn('px-4 py-4', className)}>
        <div className="space-y-3">
          <div>
            <div className="text-[13px] font-medium text-foreground">{title}</div>
            {description ? (
              <div className="mt-1 text-xs leading-6 text-muted-foreground">{description}</div>
            ) : null}
          </div>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('px-4 py-3.5', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0 sm:max-w-[320px]">
          <div className="text-[13px] font-medium text-foreground">{title}</div>
          {description ? (
            <div className="mt-1 text-xs leading-6 text-muted-foreground">{description}</div>
          ) : null}
        </div>
        <div className={cn('w-full sm:shrink-0', controlClassName)}>{children}</div>
      </div>
    </div>
  );
}

function Toggle({ checked, onCheckedChange, label }: ToggleProps) {
  return (
    <label className="relative inline-flex h-6 w-11 cursor-pointer items-center">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        aria-label={label}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span
        className={cn(
          'h-full w-full rounded-full bg-black/[0.12] transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgba(0,0,0,0.18)] after:transition-transform peer-focus-visible:ring-4 peer-focus-visible:ring-sky-500/20 peer-checked:bg-[#34c759] peer-checked:after:translate-x-5 dark:bg-white/[0.12] dark:peer-focus-visible:ring-primary/25 dark:peer-checked:bg-emerald-500',
        )}
      />
    </label>
  );
}

function SectionNavItem({ section, active, onClick, compact = false }: SectionNavItemProps) {
  const Icon = section.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors',
        compact ? 'min-w-max flex-none' : 'w-full',
        active
          ? 'bg-sidebar-accent text-sidebar-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--sidebar-border)_90%,transparent)]'
          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/80 hover:text-sidebar-foreground',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-[0_10px_20px_-12px_rgba(15,23,42,0.6)]',
          section.iconGradientClassName,
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="text-[13px] font-medium">{section.title}</span>
    </button>
  );
}

function ThemeModeButton({ active, icon: Icon, label, onClick }: ThemeModeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center gap-2 rounded-[18px] border px-3 py-3 text-center text-xs font-medium transition-colors',
        active
          ? 'border-sky-500 bg-sky-50 text-sky-700 shadow-[0_18px_30px_-26px_rgba(14,116,244,0.7)] dark:border-primary dark:bg-primary/10 dark:text-primary'
          : 'border-sidebar-border bg-sidebar-accent/65 text-sidebar-foreground/70 hover:bg-sidebar-accent/85 hover:text-sidebar-foreground',
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-full',
          active
            ? 'bg-gradient-to-br from-amber-300 to-orange-400 text-white dark:from-emerald-300 dark:to-teal-500'
            : 'bg-sidebar/90 text-sidebar-foreground',
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function ThemePresetButton({ selected, themeId, themeName, onClick }: ThemePresetButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-w-[110px] flex-1 items-center gap-3 rounded-[18px] border px-3 py-3 text-left transition-colors',
        selected
          ? 'border-sky-500 bg-sky-50/90 text-sky-700 dark:border-primary dark:bg-primary/10 dark:text-primary'
          : 'border-sidebar-border bg-sidebar-accent/65 text-sidebar-foreground hover:bg-sidebar-accent/85',
      )}
    >
      <span
        className="block h-9 w-14 shrink-0 rounded-xl border border-black/5 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:border-white/10"
        style={THEME_PREVIEW_STYLES[themeId] || THEME_PREVIEW_STYLES.default}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{themeName}</span>
      </span>
      {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
    </button>
  );
}

export function SettingsView({
  settingsDraft,
  setSettingsDraft,
  settingsNotice,
  autoSaveSettings,
  autoSaveImageSettings,
  themeMode,
  setThemeMode,
  cssThemeId,
  setCssThemeId,
  buddyEnabled,
  onBuddyEnabledChange,
}: SettingsViewProps) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const deferredSearchQuery = React.useDeferredValue(searchQuery.trim().toLowerCase());
  const [activeSection, setActiveSection] = React.useState<SectionId>('connection');
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const sectionRefs = React.useRef<Record<SectionId, HTMLElement | null>>({
    connection: null,
    permission: null,
    'text-model': null,
    'image-model': null,
    prompt: null,
    'im-adapter': null,
    buddy: null,
    appearance: null,
  });

  const visibleSections = SECTION_DEFINITIONS.filter((section) => {
    if (!deferredSearchQuery) return true;
    const haystack = [section.title, ...section.keywords].join(' ').toLowerCase();
    return haystack.includes(deferredSearchQuery);
  });
  const visibleSectionKey = visibleSections.map((section) => section.id).join('|');
  const firstVisibleSectionId = visibleSections[0]?.id;
  const activeSectionVisible = visibleSections.some((section) => section.id === activeSection);
  const imageDraft = settingsDraft?.image || DEFAULT_IMAGE_SETTINGS;

  React.useEffect(() => {
    if (!activeSectionVisible && firstVisibleSectionId) {
      setActiveSection(firstVisibleSectionId);
    }
  }, [activeSectionVisible, firstVisibleSectionId]);

  React.useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const updateActive = () => {
      const threshold = container.scrollTop + 108;
      let nextSection = firstVisibleSectionId || 'connection';

      for (const section of visibleSections) {
        const element = sectionRefs.current[section.id];
        if (!element) continue;
        if (element.offsetTop <= threshold) {
          nextSection = section.id;
        }
      }

      setActiveSection((current) => (current === nextSection ? current : nextSection));
    };

    const raf = window.requestAnimationFrame(updateActive);
    container.addEventListener('scroll', updateActive, { passive: true });
    window.addEventListener('resize', updateActive);

    return () => {
      window.cancelAnimationFrame(raf);
      container.removeEventListener('scroll', updateActive);
      window.removeEventListener('resize', updateActive);
    };
  }, [
    firstVisibleSectionId,
    visibleSectionKey,
    settingsDraft?.remoteEnabled,
    settingsDraft?.remoteDirectCredentialMode,
    settingsDraft?.thinkingMode,
    buddyEnabled,
  ]);

  const scrollToSection = (sectionId: SectionId) => {
    setActiveSection(sectionId);
    const container = scrollRef.current;
    const section = sectionRefs.current[sectionId];
    if (!container || !section) return;
    container.scrollTo({
      top: Math.max(0, section.offsetTop - 24),
      behavior: 'smooth',
    });
  };

  const updateSetting = <K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]) => {
    setSettingsDraft((current) => (current ? { ...current, [key]: value } : current));
    void autoSaveSettings(key, value);
  };

  const updateImageSettings = (patch: Partial<DesktopSettings['image']>) => {
    const nextImage = {
      ...imageDraft,
      ...patch,
    };
    setSettingsDraft((current) => (current ? { ...current, image: nextImage } : current));
    void autoSaveImageSettings(nextImage);
  };

  const copyText = (value: string) => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
  };

  if (!settingsDraft) {
    return (
      <div className="h-full overflow-auto p-6">
        <Surface className="p-8">
          <p className="text-sm font-medium text-foreground">正在读取设置…</p>
          <p className="mt-2 text-sm leading-7 text-muted-foreground">
            设置文件和当前主题配置加载后会显示完整的设置界面。
          </p>
        </Surface>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden bg-sidebar/96 text-sidebar-foreground">
      <div className="flex h-full">
          <aside className="hidden w-[232px] shrink-0 border-r border-sidebar-border bg-sidebar/96 lg:block">
            <div className="sticky top-0 p-4">
              <div className="mb-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    className={cn(FIELD_CLASS_NAME, 'h-10 rounded-2xl pl-9')}
                    placeholder="搜索设置"
                  />
                </div>
              </div>
              <nav className="space-y-1">
                {visibleSections.map((section) => (
                  <SectionNavItem
                    key={section.id}
                    section={section}
                    active={section.id === activeSection}
                    onClick={() => scrollToSection(section.id)}
                  />
                ))}
              </nav>
            </div>
          </aside>

          <div className="min-w-0 flex-1 overflow-hidden bg-sidebar/96">
            <div className="flex h-full flex-col">
              <div className="border-b border-sidebar-border bg-sidebar/96 px-4 py-4 lg:hidden">
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      className={cn(FIELD_CLASS_NAME, 'h-10 rounded-2xl pl-9')}
                      placeholder="搜索设置"
                    />
                  </div>
                  <div className="-mx-1 overflow-x-auto pb-1">
                    <div className="flex gap-2 px-1">
                      {visibleSections.map((section) => (
                        <SectionNavItem
                          key={section.id}
                          section={section}
                          compact
                          active={section.id === activeSection}
                          onClick={() => scrollToSection(section.id)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
                <div className="space-y-5 p-4 pb-10 sm:p-5 sm:pb-10 lg:p-6 lg:pb-12">
                  <div className="px-1">
                    <h1 className="text-3xl font-semibold tracking-tight text-foreground">设置</h1>
                  </div>

                  {settingsDraft.settingsParseError ? (
                    <Surface className="border-amber-200/80 bg-amber-50/90 p-4 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                      <div className="flex items-start gap-3">
                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">设置文件解析失败</p>
                          <p className="mt-1 text-xs leading-6 opacity-90">{settingsDraft.settingsParseError}</p>
                        </div>
                      </div>
                    </Surface>
                  ) : null}

                  {settingsNotice ? (
                    <Surface className="border-rose-200/80 bg-rose-50/90 p-4 text-rose-950 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">
                      <div className="flex items-start gap-3">
                        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">保存设置时发生错误</p>
                          <p className="mt-1 text-xs leading-6 opacity-90">{settingsNotice}</p>
                        </div>
                      </div>
                    </Surface>
                  ) : null}

                  {visibleSections.length === 0 ? (
                    <Surface className="p-6">
                      <p className="text-sm font-medium text-foreground">没有找到匹配的设置项</p>
                      <p className="mt-2 text-sm leading-7 text-muted-foreground">
                        当前搜索词没有命中任何分组，可以清空搜索后查看全部设置。
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4 rounded-xl"
                        onClick={() => setSearchQuery('')}
                      >
                        清空搜索
                      </Button>
                    </Surface>
                  ) : null}

                {visibleSections.some((section) => section.id === 'connection') ? (
                  <SettingsSection
                    id="connection"
                    title="连接"
                    sectionRef={(element) => {
                      sectionRefs.current.connection = element;
                    }}
                  >
                    <div className="space-y-3">
                      {/* 本地模式 */}
                      <SettingsGroup>
                        <SettingsRow
                          title="本地模式"
                          description="在本机运行 Agent，直接使用本地文本模型配置。"
                          controlClassName="sm:w-[56px]"
                        >
                          <div className="flex justify-start sm:justify-end">
                            <Toggle
                              checked={settingsDraft.localEnabled ?? true}
                              onCheckedChange={(checked) => {
                                updateSetting('localEnabled', checked);
                                if (!checked) {
                                  updateSetting('agentMode', 'remote-direct');
                                } else if (!(settingsDraft.remoteEnabled ?? false)) {
                                  updateSetting('agentMode', 'local');
                                }
                              }}
                              label="本地模式"
                            />
                          </div>
                        </SettingsRow>
                      </SettingsGroup>

                      {/* 远程模式 */}
                      <SettingsGroup>
                        <SettingsRow
                          title="远程模式"
                          description="连接到远端 Moss 服务器运行 Agent。"
                          controlClassName="sm:w-[56px]"
                        >
                          <div className="flex justify-start sm:justify-end">
                            <Toggle
                              checked={settingsDraft.remoteEnabled ?? false}
                              onCheckedChange={(checked) => {
                                updateSetting('remoteEnabled', checked);
                                if (!checked) {
                                  updateSetting('agentMode', 'local');
                                } else if (!(settingsDraft.localEnabled ?? true)) {
                                  updateSetting('agentMode', 'remote-direct');
                                }
                              }}
                              label="远程模式"
                            />
                          </div>
                        </SettingsRow>

                        {(settingsDraft.remoteEnabled ?? false) ? (
                          <>
                            <SettingsRow
                              title="服务器地址"
                              controlClassName="sm:w-[360px]"
                            >
                              <Input
                                className={FIELD_CLASS_NAME}
                                value={settingsDraft.remoteDirectServerUrl || ''}
                                onChange={(event) => updateSetting('remoteDirectServerUrl', event.target.value)}
                                placeholder="http://127.0.0.1:43127 或 cc://server:43127"
                              />
                            </SettingsRow>

                            <SettingsRow
                              title="凭据类型"
                              controlClassName="sm:w-[180px]"
                            >
                              <select
                                className={SELECT_CLASS_NAME}
                                value={settingsDraft.remoteDirectCredentialMode ?? 'password'}
                                onChange={(event) => {
                                  updateSetting(
                                    'remoteDirectCredentialMode',
                                    event.target.value as DesktopSettings['remoteDirectCredentialMode'],
                                  );
                                }}
                              >
                                <option value="password">密码</option>
                                <option value="api-key">API Key</option>
                              </select>
                            </SettingsRow>

                            {settingsDraft.remoteDirectCredentialMode === 'api-key' ? (
                              <SettingsRow
                                title="API Key"
                                controlClassName="sm:w-[360px]"
                              >
                                <Input
                                  className={cn(FIELD_CLASS_NAME, 'font-mono text-xs')}
                                  value={settingsDraft.remoteDirectApiKey || ''}
                                  onChange={(event) => updateSetting('remoteDirectApiKey', event.target.value)}
                                  placeholder="moss_live_..."
                                />
                              </SettingsRow>
                            ) : (
                              <>
                                <SettingsRow
                                  title="用户名或邮箱"
                                  controlClassName="sm:w-[280px]"
                                >
                                  <Input
                                    className={FIELD_CLASS_NAME}
                                    value={settingsDraft.remoteDirectUserEmail || ''}
                                    onChange={(event) => updateSetting('remoteDirectUserEmail', event.target.value)}
                                    placeholder="请输入用户名或邮箱"
                                  />
                                </SettingsRow>

                                <SettingsRow
                                  title="密码"
                                  controlClassName="sm:w-[280px]"
                                >
                                  <Input
                                    type="password"
                                    className={FIELD_CLASS_NAME}
                                    value={settingsDraft.remoteDirectUserPassword || ''}
                                    onChange={(event) => updateSetting('remoteDirectUserPassword', event.target.value)}
                                    placeholder="请输入密码"
                                  />
                                </SettingsRow>
                              </>
                            )}

                            <SettingsRow
                              title="工作空间"
                              controlClassName="sm:w-[320px]"
                            >
                              <Input
                                className={FIELD_CLASS_NAME}
                                value={settingsDraft.remoteDirectWorkspace || ''}
                                onChange={(event) => updateSetting('remoteDirectWorkspace', event.target.value)}
                                placeholder="/srv/moss/workspaces/default"
                              />
                            </SettingsRow>

                            <div className="px-4 py-4">
                              <div className="rounded-[18px] border border-amber-200/80 bg-amber-50/[0.85] px-4 py-3 text-xs leading-6 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
                                当前版本会把远程登录凭据保存在本机 `~/.moss/settings.json`。后续应该迁移到系统密钥链，已记录在
                                `ui/plan.md`。
                              </div>
                            </div>
                          </>
                        ) : null}
                      </SettingsGroup>
                    </div>
                  </SettingsSection>
                ) : null}

                {visibleSections.some((section) => section.id === 'permission') ? (
                  <SettingsSection
                    id="permission"
                    title="权限"
                    sectionRef={(element) => {
                      sectionRefs.current.permission = element;
                    }}
                  >
                    <SettingsGroup>
                      <SettingsRow
                        title="跳过所有权限确认"
                        description="打开后，工具调用不再弹确认框，直接使用 allow-all / bypass 模式。"
                        controlClassName="sm:w-[56px]"
                      >
                        <div className="flex justify-start sm:justify-end">
                          <Toggle
                            checked={Boolean(settingsDraft.bypassPermissions)}
                            onCheckedChange={(checked) => updateSetting('bypassPermissions', checked)}
                            label="跳过所有权限确认"
                          />
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title="最大轮次"
                        description="当前仅 `local` 模式生效。"
                        controlClassName="sm:w-[112px]"
                      >
                        <Input
                          type="number"
                          min={1}
                          max={10000}
                          className={FIELD_CLASS_NAME}
                          value={settingsDraft.maxTurns ?? 100}
                          onChange={(event) => {
                            const value = Number.parseInt(event.target.value || '1', 10);
                            updateSetting('maxTurns', value);
                          }}
                        />
                      </SettingsRow>

                      <SettingsRow
                        title="思考模式"
                        description="当前仅 `local` 模式生效。"
                        controlClassName="sm:w-[220px]"
                      >
                        <select
                          className={SELECT_CLASS_NAME}
                          value={settingsDraft.thinkingMode ?? 'disabled'}
                          onChange={(event) => {
                            updateSetting('thinkingMode', event.target.value as DesktopSettings['thinkingMode']);
                          }}
                        >
                          <option value="disabled">disabled (关闭)</option>
                          <option value="adaptive">adaptive (自动)</option>
                          <option value="enabled">enabled (强制开启)</option>
                          <option value="">default (保持手动配置)</option>
                        </select>
                      </SettingsRow>

                      {settingsDraft.thinkingMode === 'enabled' ? (
                        <SettingsRow
                          title="Thinking Budget Tokens"
                          description="只在强制开启思考模式时显示。"
                          controlClassName="sm:w-[180px]"
                        >
                          <Input
                            type="number"
                            min={1024}
                            max={128000}
                            className={FIELD_CLASS_NAME}
                            value={settingsDraft.thinkingBudgetTokens ?? 16000}
                            onChange={(event) => {
                              const value = Number.parseInt(event.target.value || '1024', 10);
                              updateSetting('thinkingBudgetTokens', value);
                            }}
                            placeholder="thinking budget tokens"
                          />
                        </SettingsRow>
                      ) : null}
                    </SettingsGroup>
                  </SettingsSection>
                ) : null}

                {visibleSections.some((section) => section.id === 'text-model') ? (
                  <SettingsSection
                    id="text-model"
                    title="文本模型"
                    sectionRef={(element) => {
                      sectionRefs.current['text-model'] = element;
                    }}
                  >
                    <SettingsGroup>
                      <SettingsRow
                        title="默认模型"
                        controlClassName="sm:w-[280px]"
                      >
                        <Input
                          className={FIELD_CLASS_NAME}
                          value={settingsDraft.model || ''}
                          onChange={(event) => updateSetting('model', event.target.value)}
                          placeholder="claude-sonnet-4-6"
                        />
                      </SettingsRow>

                      <SettingsRow
                        title="API URL"
                        controlClassName="sm:w-[380px]"
                      >
                        <Input
                          className={FIELD_CLASS_NAME}
                          value={settingsDraft.url || ''}
                          onChange={(event) => updateSetting('url', event.target.value)}
                          placeholder="https://api.anthropic.com"
                        />
                      </SettingsRow>

                      <SettingsRow
                        title="API Key"
                        controlClassName="sm:w-[380px]"
                      >
                        <div className="flex w-full gap-2">
                          <Input
                            className={cn(FIELD_CLASS_NAME, 'font-mono text-xs')}
                            value={settingsDraft.apiKey || ''}
                            onChange={(event) => updateSetting('apiKey', event.target.value)}
                            placeholder="sk-ant-..."
                          />
                          {settingsDraft.apiKey ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-9 rounded-xl border-black/10 bg-white/90 px-3 dark:border-white/10 dark:bg-background/75"
                              onClick={() => copyText(settingsDraft.apiKey || '')}
                            >
                              复制
                            </Button>
                          ) : null}
                        </div>
                      </SettingsRow>
                    </SettingsGroup>
                  </SettingsSection>
                ) : null}

                {visibleSections.some((section) => section.id === 'image-model') ? (
                  <SettingsSection
                    id="image-model"
                    title="图片模型"
                    sectionRef={(element) => {
                      sectionRefs.current['image-model'] = element;
                    }}
                  >
                    <SettingsGroup>
                      <SettingsRow
                        title="图片厂商"
                        controlClassName="sm:w-[180px]"
                      >
                        <select
                          className={SELECT_CLASS_NAME}
                          value={imageDraft.provider ?? 'minimax'}
                          onChange={(event) => updateImageSettings({ provider: event.target.value })}
                        >
                          <option value="minimax">MiniMax</option>
                        </select>
                      </SettingsRow>

                      <SettingsRow
                        title="API URL"
                        controlClassName="sm:w-[380px]"
                      >
                        <Input
                          className={FIELD_CLASS_NAME}
                          value={imageDraft.url || ''}
                          onChange={(event) => updateImageSettings({ url: event.target.value })}
                          placeholder="https://api.minimaxi.com/v1/image_generation"
                        />
                      </SettingsRow>

                      <SettingsRow
                        title="API Key"
                        controlClassName="sm:w-[380px]"
                      >
                        <div className="flex w-full gap-2">
                          <Input
                            type="password"
                            className={cn(FIELD_CLASS_NAME, 'font-mono text-xs')}
                            value={imageDraft.apiKey || ''}
                            onChange={(event) => updateImageSettings({ apiKey: event.target.value })}
                            placeholder="sk-..."
                          />
                          {imageDraft.apiKey ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-9 rounded-xl border-black/10 bg-white/90 px-3 dark:border-white/10 dark:bg-background/75"
                              onClick={() => copyText(imageDraft.apiKey || '')}
                            >
                              复制
                            </Button>
                          ) : null}
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title="图片模型"
                        controlClassName="sm:w-[280px]"
                      >
                        <Input
                          className={FIELD_CLASS_NAME}
                          value={imageDraft.model || ''}
                          onChange={(event) => updateImageSettings({ model: event.target.value })}
                          placeholder="image-01"
                        />
                      </SettingsRow>
                    </SettingsGroup>
                  </SettingsSection>
                ) : null}

                {visibleSections.some((section) => section.id === 'prompt') ? (
                  <SettingsSection
                    id="prompt"
                    title="系统提示"
                    sectionRef={(element) => {
                      sectionRefs.current.prompt = element;
                    }}
                  >
                    <Surface className="p-0">
                      <SettingsRow
                        title="追加系统提示"
                        stacked
                      >
                        <Textarea
                          className={cn(
                            'min-h-[180px] rounded-[18px] border-black/10 bg-[#fafafc] text-[13px] shadow-none dark:border-white/10 dark:bg-background/[0.55]',
                          )}
                          value={settingsDraft.appendSystemPrompt || ''}
                          onChange={(event) => updateSetting('appendSystemPrompt', event.target.value)}
                          placeholder="例如：默认使用中文回复；修改代码前先解释关键影响；避免自动删除用户未要求的文件。"
                        />
                      </SettingsRow>
                    </Surface>
                  </SettingsSection>
                ) : null}

                {visibleSections.some((section) => section.id === 'im-adapter') ? (
                  <SettingsSection
                    id="im-adapter"
                    title="IM 接入"
                    sectionRef={(element) => {
                      sectionRefs.current['im-adapter'] = element;
                    }}
                  >
                    <ImAdapterSettings />
                  </SettingsSection>
                ) : null}

                {visibleSections.some((section) => section.id === 'buddy') ? (
                  <SettingsSection
                    id="buddy"
                    title="Buddy"
                    sectionRef={(element) => {
                      sectionRefs.current.buddy = element;
                    }}
                  >
                    <SettingsGroup>
                      <SettingsRow
                        title="Buddy 伴侣精灵"
                        description="开启后在侧边栏显示你的专属宠物陪伴。"
                        controlClassName="sm:w-[56px]"
                      >
                        <div className="flex justify-start sm:justify-end">
                          <Toggle
                            checked={buddyEnabled}
                            onCheckedChange={onBuddyEnabledChange}
                            label="启用 Buddy 伴侣精灵"
                          />
                        </div>
                      </SettingsRow>

                      {buddyEnabled ? (
                        <SettingsRow
                          title="Buddy 状态"
                          description="在这里孵化、查看和编辑当前的陪伴精灵。"
                          stacked
                        >
                          <BuddySummary />
                        </SettingsRow>
                      ) : (
                        <div className="px-4 py-4">
                          <div className="rounded-[18px] border border-dashed border-black/10 bg-[#fafafc] px-4 py-3 text-xs leading-6 text-muted-foreground dark:border-white/10 dark:bg-background/[0.35]">
                            Buddy 已关闭。重新开启后，侧边栏会恢复显示宠物陪伴。
                          </div>
                        </div>
                      )}
                    </SettingsGroup>
                  </SettingsSection>
                ) : null}

                {visibleSections.some((section) => section.id === 'appearance') ? (
                  <SettingsSection
                    id="appearance"
                    title="外观"
                    sectionRef={(element) => {
                      sectionRefs.current.appearance = element;
                    }}
                  >
                    <SettingsGroup>
                      <SettingsRow
                        title="主题"
                        description="选择浅色、暗色或跟随系统的主题模式。"
                        stacked
                      >
                        <div className="flex flex-col gap-3 sm:flex-row">
                          <ThemeModeButton
                            active={themeMode === 'light'}
                            icon={SunMedium}
                            label="浅色"
                            onClick={() => setThemeMode('light')}
                          />
                          <ThemeModeButton
                            active={themeMode === 'system'}
                            icon={Monitor}
                            label="跟随系统"
                            onClick={() => setThemeMode('system')}
                          />
                          <ThemeModeButton
                            active={themeMode === 'dark'}
                            icon={MoonStar}
                            label="暗色"
                            onClick={() => setThemeMode('dark')}
                          />
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title="背景样式"
                        description="选择预设的背景纹理或渐变。"
                        stacked
                      >
                        <div className="flex flex-wrap gap-3">
                          {PRESET_THEMES.map((theme) => (
                            <ThemePresetButton
                              key={theme.id}
                              selected={cssThemeId === theme.id}
                              themeId={theme.id}
                              themeName={theme.name}
                              onClick={() => setCssThemeId(theme.id)}
                            />
                          ))}
                        </div>
                      </SettingsRow>
</SettingsGroup>
                   </SettingsSection>
                 ) : null}
               </div>
               </div>
             </div>
           </div>
         </div>
     </div>
   );
}

type ImTab = 'feishu' | 'telegram'

function ImAdapterSettings() {
  const { config, isLoading, fetchConfig, updateConfig, generatePairingCode, removePairedUser } = useAdapterConfig()

  const [activeIm, setActiveIm] = React.useState<ImTab>('feishu')
  const [defaultProjectDir, setDefaultProjectDir] = React.useState('')
  const [tgBotToken, setTgBotToken] = React.useState('')
  const [tgAllowedUsers, setTgAllowedUsers] = React.useState('')
  const [fsAppId, setFsAppId] = React.useState('')
  const [fsAppSecret, setFsAppSecret] = React.useState('')
  const [fsEncryptKey, setFsEncryptKey] = React.useState('')
  const [fsVerificationToken, setFsVerificationToken] = React.useState('')
  const [fsAllowedUsers, setFsAllowedUsers] = React.useState('')
  const [fsStreamingCard, setFsStreamingCard] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const [saveStatus, setSaveStatus] = React.useState<'idle' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = React.useState('')
  const [pairingCode, setPairingCode] = React.useState<string | null>(null)
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [pendingUnbind, setPendingUnbind] = React.useState<{ platform: 'telegram' | 'feishu'; userId: string | number } | null>(null)
  const [isUnbinding, setIsUnbinding] = React.useState(false)

  React.useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  React.useEffect(() => {
    setDefaultProjectDir(config.defaultProjectDir ?? '')
    setTgBotToken(config.telegram?.botToken ?? '')
    setTgAllowedUsers(config.telegram?.allowedUsers?.join(', ') ?? '')
    setFsAppId(config.feishu?.appId ?? '')
    setFsAppSecret(config.feishu?.appSecret ?? '')
    setFsEncryptKey(config.feishu?.encryptKey ?? '')
    setFsVerificationToken(config.feishu?.verificationToken ?? '')
    setFsAllowedUsers(config.feishu?.allowedUsers?.join(', ') ?? '')
    setFsStreamingCard(config.feishu?.streamingCard ?? false)
  }, [config])

  async function handleSave() {
    setIsSaving(true)
    setSaveStatus('idle')
    setSaveError('')
    try {
      const patch: Record<string, unknown> = {}
      if (defaultProjectDir) patch.defaultProjectDir = defaultProjectDir
      const tgUsers = tgAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n))
      patch.telegram = {
        botToken: tgBotToken || undefined,
        allowedUsers: tgUsers.length ? tgUsers : [],
      }
      const fsUsers = fsAllowedUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      patch.feishu = {
        appId: fsAppId || undefined,
        appSecret: fsAppSecret || undefined,
        encryptKey: fsEncryptKey || undefined,
        verificationToken: fsVerificationToken || undefined,
        allowedUsers: fsUsers.length ? fsUsers : [],
        streamingCard: fsStreamingCard,
      }
      await updateConfig(patch as Partial<import('../types').AdapterFileConfig>)
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  const handleGenerateCode = async () => {
    setIsGenerating(true)
    try {
      const code = await generatePairingCode()
      setPairingCode(code)
    } catch (err) {
      console.error('Failed to generate pairing code:', err)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleUnbind = async () => {
    if (!pendingUnbind) return
    setIsUnbinding(true)
    try {
      await removePairedUser(pendingUnbind.platform, pendingUnbind.userId)
      await fetchConfig()
      setPendingUnbind(null)
    } finally {
      setIsUnbinding(false)
    }
  }

  const allPairedUsers = [
    ...(config.telegram?.pairedUsers ?? []).map((u) => ({ ...u, platform: 'telegram' as const })),
    ...(config.feishu?.pairedUsers ?? []).map((u) => ({ ...u, platform: 'feishu' as const })),
  ]

  const pairingExpiry = config.pairing?.expiresAt
  const isPairingActive = pairingExpiry ? Date.now() < pairingExpiry : false
  const minutesLeft = pairingExpiry ? Math.max(0, Math.ceil((pairingExpiry - Date.now()) / 60000)) : 0

  if (isLoading) {
    return (
      <Surface className="p-6">
        <p className="text-sm font-medium text-foreground">正在加载 IM 接入配置…</p>
      </Surface>
    )
  }

  return (
    <div className="space-y-5">
      <SettingsGroup>
        <SettingsRow title="IM 接入" description="配置飞书和 Telegram 机器人接入，允许用户通过 IM 应用与 AI 对话。" stacked>
          <p className="text-xs leading-6 text-muted-foreground">在飞书或 Telegram 创建机器人，填入凭据后用户即可通过 IM 与 Agent 交互。</p>
        </SettingsRow>
      </SettingsGroup>

      {/* Pairing */}
      <Surface>
        <div className="flex items-center gap-2 border-b border-sidebar-border bg-sidebar-accent/58 px-4 py-3">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">配对管理</span>
        </div>
        <div className="space-y-4 p-4">
          <p className="text-xs leading-6 text-muted-foreground">生成配对码后，在飞书或 Telegram 机器人中输入该码即可绑定账号。</p>

          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" className="rounded-xl" onClick={handleGenerateCode} disabled={isGenerating}>
              {pairingCode || isPairingActive ? '重新生成' : '生成配对码'}
            </Button>
            {pairingCode && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-2xl font-bold tracking-[0.3em] text-primary">{pairingCode}</span>
                <span className="text-xs text-muted-foreground">60 分钟内有效</span>
              </div>
            )}
            {!pairingCode && isPairingActive && (
              <span className="text-xs text-muted-foreground">{minutesLeft} 分钟后过期</span>
            )}
          </div>

          <div>
            <p className="mb-2 text-[13px] font-medium text-foreground">已配对用户</p>
            {allPairedUsers.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无已配对用户</p>
            ) : (
              <div className="space-y-2">
                {allPairedUsers.map((user) => (
                  <div
                    key={`${user.platform}-${user.userId}`}
                    className="flex items-center justify-between rounded-xl border border-sidebar-border bg-sidebar-accent/70 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-sidebar px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {user.platform === 'feishu' ? '飞书' : 'Telegram'}
                      </span>
                      <span className="text-[13px] text-foreground">{user.displayName}</span>
                      <span className="text-xs text-muted-foreground">{new Date(user.pairedAt).toLocaleDateString()}</span>
                    </div>
                    <button
                      onClick={() => setPendingUnbind({ platform: user.platform, userId: user.userId })}
                      className="text-xs text-destructive hover:underline"
                    >
                      解绑
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Surface>

      {/* Default Project */}
      <SettingsGroup>
        <SettingsRow title="默认工作目录" description="IM 会话的默认项目路径，不指定时使用服务器工作目录。" controlClassName="sm:w-[360px]">
          <Input
            className={FIELD_CLASS_NAME}
            value={defaultProjectDir}
            onChange={(e) => setDefaultProjectDir(e.target.value)}
            placeholder="/path/to/project"
          />
        </SettingsRow>
      </SettingsGroup>

      {/* IM Tabs */}
      <Surface>
        <div role="tablist" aria-label="IM adapter" className="flex items-stretch border-b border-sidebar-border bg-sidebar-accent/58">
          <button
            type="button"
            role="tab"
            aria-selected={activeIm === 'feishu'}
            onClick={() => setActiveIm('feishu')}
            className={cn(
              'relative px-4 py-2.5 text-[13px] font-medium transition-colors',
              activeIm === 'feishu'
                ? 'text-foreground after:absolute after:left-3 after:right-3 after:bottom-0 after:h-[2px] after:bg-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            飞书
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeIm === 'telegram'}
            onClick={() => setActiveIm('telegram')}
            className={cn(
              'relative px-4 py-2.5 text-[13px] font-medium transition-colors',
              activeIm === 'telegram'
                ? 'text-foreground after:absolute after:left-3 after:right-3 after:bottom-0 after:h-[2px] after:bg-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Telegram
          </button>
        </div>

        {activeIm === 'feishu' && (
          <div className="space-y-3 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-[13px] font-medium text-foreground">App ID</label>
                <Input className={FIELD_CLASS_NAME} value={fsAppId} onChange={(e) => setFsAppId(e.target.value)} placeholder="cli_xxxxxxxx" />
              </div>
              <div className="space-y-1.5">
                <label className="text-[13px] font-medium text-foreground">App Secret</label>
                <Input type="password" className={FIELD_CLASS_NAME} value={fsAppSecret} onChange={(e) => setFsAppSecret(e.target.value)} placeholder="****" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-[13px] font-medium text-foreground">Encrypt Key</label>
                <Input type="password" className={FIELD_CLASS_NAME} value={fsEncryptKey} onChange={(e) => setFsEncryptKey(e.target.value)} placeholder="****" />
              </div>
              <div className="space-y-1.5">
                <label className="text-[13px] font-medium text-foreground">Verification Token</label>
                <Input type="password" className={FIELD_CLASS_NAME} value={fsVerificationToken} onChange={(e) => setFsVerificationToken(e.target.value)} placeholder="****" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[13px] font-medium text-foreground">允许的用户 ID</label>
              <Input className={FIELD_CLASS_NAME} value={fsAllowedUsers} onChange={(e) => setFsAllowedUsers(e.target.value)} placeholder="ou_xxx, ou_yyy（逗号分隔，留空允许所有人）" />
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={fsStreamingCard}
                onChange={(e) => setFsStreamingCard(e.target.checked)}
                className="h-4 w-4 rounded border-sidebar-border accent-primary"
              />
              <div>
                <span className="text-[13px] font-medium text-foreground">流式卡片</span>
                <p className="text-xs text-muted-foreground">开启后，飞书消息流式更新（需要应用支持）</p>
              </div>
            </label>
          </div>
        )}

        {activeIm === 'telegram' && (
          <div className="space-y-3 p-4">
            <div className="space-y-1.5">
              <label className="text-[13px] font-medium text-foreground">Bot Token</label>
              <Input type="password" className={cn(FIELD_CLASS_NAME, 'font-mono text-xs')} value={tgBotToken} onChange={(e) => setTgBotToken(e.target.value)} placeholder="123456:ABC-DEF..." />
            </div>
            <div className="space-y-1.5">
              <label className="text-[13px] font-medium text-foreground">允许的用户 ID</label>
              <Input className={FIELD_CLASS_NAME} value={tgAllowedUsers} onChange={(e) => setTgAllowedUsers(e.target.value)} placeholder="123456789, 987654321（逗号分隔，留空允许所有人）" />
            </div>
          </div>
        )}
      </Surface>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={isSaving} className="rounded-xl">
          {isSaving ? '保存中…' : saveStatus === 'saved' ? '已保存 ✓' : '保存配置'}
        </Button>
        {saveStatus === 'error' && (
          <span className="text-sm text-destructive">{saveError}</span>
        )}
      </div>

      {/* Unbind confirm */}
      {pendingUnbind && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!isUnbinding) setPendingUnbind(null) }}>
          <div className="w-[360px] rounded-[20px] bg-background p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-[13px] font-medium text-foreground">确认解绑</p>
            <p className="mt-2 text-xs text-muted-foreground">确定要解绑该用户吗？解绑后该用户将无法再通过 IM 与 Agent 对话。</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" className="rounded-xl" onClick={() => setPendingUnbind(null)} disabled={isUnbinding}>取消</Button>
              <Button size="sm" className="rounded-xl bg-destructive text-white hover:bg-destructive/90" onClick={handleUnbind} disabled={isUnbinding}>
                {isUnbinding ? '解绑中…' : '解绑'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
