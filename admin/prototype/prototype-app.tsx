import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpRight, BookOpen, Bot, Boxes, Building2, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, CircleHelp, Clock3, Command, Copy, FileJson, FolderOpen, Globe2, KeyRound, LayoutGrid, LoaderCircle, Menu, MessageSquare, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsSections } from './settings-sections'
import { displayValue, FIELD_LABELS, INITIAL_SETTINGS, TAB_FIELDS, validateSettings, type FieldKey, type FormErrors, type Settings, type SettingsTab } from './fixtures'

const NAV_GROUPS = [
  { title: '工作空间', items: [
    { title: '工作台', icon: LayoutGrid },
    { title: '智能体', icon: Bot },
    { title: '会话记录', icon: MessageSquare },
    { title: '知识与文档', icon: FolderOpen },
    { title: '技能商店', icon: Boxes },
    { title: '定时任务', icon: Clock3 },
  ] },
  { title: '组织管理', items: [
    { title: '成员与组织', icon: Users },
    { title: '应用与渠道', icon: Globe2 },
    { title: '凭据中心', icon: KeyRound },
  ] },
  { title: '系统', items: [
    { title: '企业信息', icon: Building2 },
    { title: '系统设置', icon: Settings2 },
    { title: '服务器凭据', icon: Server },
  ] },
]

const TABS: { value: SettingsTab; label: string; icon: typeof Sparkles }[] = [
  { value: 'models', label: '模型配置', icon: Sparkles },
  { value: 'runtime', label: '执行与权限', icon: ShieldCheck },
  { value: 'clients', label: '客户端与集成', icon: SlidersHorizontal },
]

type Modal = 'search' | 'organization' | 'guide' | 'config' | 'review' | 'account' | 'placeholder' | null

function MossMark() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect width="40" height="40" rx="11" fill="currentColor" /><path d="M11 27V18a4 4 0 0 1 8 0v9m2 0V18a4 4 0 0 1 8 0v9" stroke="white" strokeWidth="3.5" strokeLinecap="round" /></svg>
}

export function PrototypeApp() {
  const [tab, setTab] = useState<SettingsTab>('models')
  const [draft, setDraft] = useState<Settings>({ ...INITIAL_SETTINGS })
  const [saved, setSaved] = useState<Settings>({ ...INITIAL_SETTINGS })
  const [errors, setErrors] = useState<FormErrors>({})
  const [saving, setSaving] = useState(false)
  const [hasSaved, setHasSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [dark, setDark] = useState(false)
  const [modal, setModal] = useState<Modal>(null)
  const [placeholderTitle, setPlaceholderTitle] = useState('')
  const [organization, setOrganization] = useState('Default Organization')
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const testTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const changedKeys = (Object.keys(draft) as FieldKey[]).filter(key => draft[key] !== saved[key])
  const dirty = changedKeys.length > 0

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    return () => document.documentElement.classList.remove('dark')
  }, [dark])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setQuery('')
        setModal(current => current === 'search' ? null : 'search')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(saveTimer.current)
      clearTimeout(testTimer.current)
    }
  }, [])

  useEffect(() => {
    const viewport = window.matchMedia('(max-width: 700px)')
    const closeDesktopDrawer = () => { if (!viewport.matches) setMobileOpen(false) }
    viewport.addEventListener('change', closeDesktopDrawer)
    return () => viewport.removeEventListener('change', closeDesktopDrawer)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!dirty) return
    const onLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  function update<K extends FieldKey>(key: K, value: Settings[K]) {
    setDraft(current => ({ ...current, [key]: value }))
    setErrors(current => ({ ...current, [key]: undefined }))
    if (['apiUrl', 'apiKey', 'model'].includes(key)) {
      clearTimeout(testTimer.current)
      setTesting(false)
      setTestResult(false)
    }
  }

  function saveChanges() {
    const nextErrors = validateSettings(draft)
    setErrors(nextErrors)
    const invalidTab = TABS.find(item => TAB_FIELDS[item.value].some(key => nextErrors[key]))
    if (invalidTab) {
      setTab(invalidTab.value)
      setToast('还有配置需要检查，请修正标记的字段。')
      return
    }
    setSaving(true)
    saveTimer.current = setTimeout(() => {
      setSaved({ ...draft })
      setSaving(false)
      setHasSaved(true)
      setToast('已保存到当前原型页面，真实服务配置未改变。')
    }, 550)
  }

  function testConnection() {
    const nextErrors = validateSettings(draft)
    const connectionErrors = Object.fromEntries(['apiUrl', 'apiKey'].filter(key => nextErrors[key as FieldKey]).map(key => [key, nextErrors[key as FieldKey]]))
    setErrors(current => ({ ...current, ...connectionErrors }))
    if (Object.keys(connectionErrors).length) return
    setTesting(true)
    testTimer.current = setTimeout(() => { setTesting(false); setTestResult(true) }, 800)
  }

  function navigate(title: string) {
    setMobileOpen(false)
    if (title === '系统设置') {
      setModal(null)
      return
    }
    setPlaceholderTitle(title)
    setModal('placeholder')
  }

  const previewConfig = JSON.stringify({
    model: draft.model,
    url: draft.apiUrl,
    apiKey: '[示例密钥，已隐藏]',
    image: { enabled: draft.imageEnabled, model: draft.imageModel, url: draft.imageUrl },
    requireApproval: draft.requireApproval,
    maxTurns: Number(draft.maxTurns),
    thinkingMode: draft.thinkingMode,
    clientCronEnabled: draft.clientCronEnabled,
    showToolCalls: draft.showToolCalls,
    uploadLimitMB: Number(draft.uploadLimit),
    oauthEnabled: draft.oauthEnabled,
  }, null, 2)

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(previewConfig)
      setToast('已复制脱敏的原型配置。')
    } catch {
      setToast('浏览器未允许复制，请在配置面板中手动选择文本。')
    }
  }

  function sidebarContent(isMobile = false) {
    return <>
      <div className="brand-row"><div className="brand-mark"><MossMark /></div><span className="brand-name">moss<span>中控平台</span></span>{!isMobile && <button type="button" className="icon-button collapse-button" aria-label={collapsed ? '展开侧栏' : '收起侧栏'} title={collapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>}</div>
      <button type="button" className="organization-switch" onClick={() => { setMobileOpen(false); setModal('organization') }} title={organization}><span className="organization-avatar">D</span><span className="organization-copy"><strong>{organization}</strong><small>企业工作空间</small></span><ChevronDown size={14} className="organization-chevron" /></button>
      <button type="button" className="sidebar-search" onClick={() => { setMobileOpen(false); setQuery(''); setModal('search') }} title="搜索菜单与设置"><Search size={16} /><span>搜索菜单与设置</span><kbd>⌘ K</kbd></button>
      <nav className="sidebar-navigation" aria-label="主导航">{NAV_GROUPS.map(group => <div className="nav-group" key={group.title}><p className="nav-group-title">{group.title}</p>{group.items.map(item => <button key={item.title} type="button" className={`nav-item ${item.title === '系统设置' ? 'active' : ''}`} aria-current={item.title === '系统设置' ? 'page' : undefined} title={item.title} onClick={() => navigate(item.title)}><item.icon size={17} strokeWidth={1.7} /><span>{item.title}</span>{item.title === '系统设置' && <span className="nav-active-mark" />}</button>)}</div>)}</nav>
      <div className="sidebar-bottom"><button type="button" className="sidebar-help" title="查看原型说明" onClick={() => { setMobileOpen(false); setModal('guide') }}><CircleHelp size={16} /><span>帮助与设计说明</span><ArrowUpRight size={13} /></button><div className="local-environment"><span className="environment-dot" /><span>本地演示环境</span><span className="version-label">v0.1</span></div><button type="button" className="account-button" title="管理员账户" onClick={() => { setMobileOpen(false); setModal('account') }}><span className="user-avatar">A</span><span className="account-copy"><strong>管理员</strong><small>admin</small></span><MoreHorizontal size={18} /></button></div>
    </>
  }

  const modalTitle = modal === 'search' ? '快速跳转' : modal === 'organization' ? '切换工作空间' : modal === 'guide' ? '为专注管理而设计' : modal === 'config' ? '配置预览' : modal === 'review' ? '查看未保存的更改' : modal === 'account' ? '管理员账户' : placeholderTitle
  const searchItems = [
    ...TABS.map(item => ({ label: item.label, detail: '系统设置', action: () => { setTab(item.value); setModal(null) } })),
    ...NAV_GROUPS.flatMap(group => group.items.map(item => ({ label: item.title, detail: group.title, action: () => navigate(item.title) }))),
  ].filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className={`prototype-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <a href="#main-content" className="skip-link">跳转到主要内容</a>
      <aside className="prototype-sidebar">{sidebarContent()}</aside>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}><DialogContent className="mobile-sidebar-panel"><DialogTitle className="sr-only">主导航</DialogTitle><DialogDescription className="sr-only">选择工作空间或访问系统设置。</DialogDescription>{sidebarContent(true)}</DialogContent></Dialog>
      <div className="prototype-workspace">
        <header className="workspace-header"><div className="header-breadcrumb"><button type="button" className="icon-button mobile-menu-button" aria-label="打开导航" onClick={() => setMobileOpen(true)}><Menu size={19} /></button><span>系统</span><ChevronRight size={13} /><strong>系统设置</strong></div><div className="header-tools"><span className="prototype-badge"><span />交互原型</span><span className="header-divider" /><button type="button" className="icon-button" aria-label={dark ? '切换浅色模式' : '切换深色模式'} title={dark ? '切换浅色模式' : '切换深色模式'} onClick={() => setDark(!dark)}>{dark ? <Sun size={17} /> : <Moon size={17} />}</button><button type="button" className="icon-button" aria-label="查看帮助" onClick={() => setModal('guide')}><CircleHelp size={17} /></button></div></header>
        <main id="main-content" className="prototype-main">
          <div className="page-heading"><div><div className="title-line"><h1>系统设置</h1><span className="scope-tag"><Globe2 size={12} />全局配置</span></div><p>让模型、权限与工作方式，按照你的团队习惯运行。</p></div><Button type="button" variant="outline" size="sm" onClick={() => setModal('guide')}><BookOpen />使用指南<ArrowUpRight /></Button></div>
          <Tabs value={tab} onValueChange={value => setTab(value as SettingsTab)} className="prototype-tabs">
            <div className="tabs-toolbar"><TabsList className="prototype-tab-list" aria-label="系统设置分类">{TABS.map(item => <TabsTrigger key={item.value} value={item.value} className="prototype-tab"><item.icon size={15} />{item.label}</TabsTrigger>)}</TabsList><button type="button" className="config-shortcut" onClick={() => setModal('config')}><FileJson size={14} /><span>配置预览</span></button></div>
            <div className="settings-layout">
              <form id="prototype-settings-form" className="settings-form" noValidate onSubmit={event => { event.preventDefault(); if (dirty && !saving) saveChanges() }}>
                <fieldset disabled={saving}><legend className="sr-only">系统设置示例表单</legend><SettingsSections draft={draft} errors={errors} update={update} testing={testing} testResult={testResult} testConnection={testConnection} /></fieldset>
                <div className="config-source"><FileJson size={15} /><span>配置来源：<strong>原型示例</strong></span><button type="button" onClick={() => setModal('config')}>查看配置<ChevronRight size={13} /></button></div>
              </form>
              <aside className="context-rail" aria-label="配置说明"><div className="context-block"><span className="context-heading">配置作用范围</span><div className="scope-server"><Server size={21} /></div><h3>一处配置，统一生效</h3><p>原型按服务器级设置设计。切换工作空间不会改变这些全局配置。</p></div><div className="context-block"><span className="context-heading">在此页面</span>{TABS.map(item => <button type="button" key={item.value} className={`rail-link ${tab === item.value ? 'selected' : ''}`} onClick={() => setTab(item.value)}>{item.label}<ChevronRight size={12} /></button>)}</div><div className="context-tip"><ShieldCheck size={19} /><h3>凭据，不必明文落盘</h3><p>正式产品使用 Nexus 管理密钥。本原型不会读取、存储或发送真实凭据。</p><button type="button" onClick={() => setModal('guide')}>了解设计<ArrowUpRight size={13} /></button></div><p className="prototype-disclaimer">你正在体验设计原型。<br />所有数据与连接状态均为示例。</p></aside>
            </div>
          </Tabs>
        </main>
        <footer className={`save-bar ${dirty ? 'has-changes' : ''}`}><div className="save-status" role="status">{saving ? <LoaderCircle className="spin" size={16} /> : dirty ? <span className="dirty-dot" /> : <CheckCheck size={16} />}<div><strong>{saving ? '正在保存到本页…' : dirty ? `有 ${changedKeys.length} 项未保存的更改` : hasSaved ? '已保存到本页' : '当前没有未保存的更改'}</strong><span>仅保存在原型页面，不影响真实服务</span></div>{dirty && <button type="button" className="review-link" onClick={() => setModal('review')}>查看更改</button>}</div><div className="save-actions"><Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => { setDraft({ ...saved }); setErrors({}); setTestResult(false); setToast('已取消未保存的更改。') }}>取消</Button><Button type="submit" form="prototype-settings-form" size="sm" disabled={!dirty || saving}>{saving ? <LoaderCircle className="spin" /> : <Check size={15} />}保存更改</Button></div></footer>
      </div>

      <Dialog open={modal !== null} onOpenChange={open => { if (!open) setModal(null) }}><DialogContent className={`prototype-dialog ${modal === 'search' ? 'search-dialog' : ''}`}><DialogHeader><DialogTitle>{modalTitle}</DialogTitle><DialogDescription>{modal === 'search' ? '搜索导航或设置分类。使用 ⌘ / Ctrl + K 随时打开。' : modal === 'review' ? '确认修改内容；API Key 始终脱敏展示。' : modal === 'config' ? '当前表单草稿的脱敏示例，不是服务器上的真实配置。' : '独立 UI 原型，不连接真实服务，也不会修改后台配置。'}</DialogDescription></DialogHeader>
        {modal === 'search' && <><div className="command-input"><Search size={18} /><input autoFocus aria-label="搜索菜单或设置" placeholder="搜索菜单或设置…" value={query} onChange={event => setQuery(event.target.value)} /></div><div className="command-results">{searchItems.length ? searchItems.map(item => <button type="button" key={`${item.detail}-${item.label}`} onClick={item.action}><span>{item.label}</span><small>{item.detail}</small><ChevronRight size={14} /></button>) : <div className="search-empty">没有找到“{query}”，试试“模型”或“权限”。</div>}</div><div className="command-footer"><Command size={12} /> 快速定位，减少来回寻找<span>Esc 关闭</span></div></>}
        {modal === 'organization' && <div className="organization-list">{['Default Organization', 'Design Sandbox'].map(name => <button key={name} type="button" onClick={() => { setOrganization(name); setModal(null); setToast('已切换示例工作空间，全局设置保持不变。') }}><span className="organization-avatar">D</span><span><strong>{name}</strong><small>示例工作空间</small></span>{organization === name && <Check size={17} />}</button>)}<p className="control-hint">这里只切换展示名称，不涉及真实租户或权限。</p></div>}
        {modal === 'guide' && <div className="design-guide"><p>这版设计聚焦于更少的视觉噪音、更明确的配置范围，以及可预期的保存行为。</p><div><strong>紧凑导航</strong><p>参考 Linear 的分组方式，让工作空间、组织管理与系统设置各归其位。</p></div><div><strong>配置与反馈</strong><p>参考 Vercel 的设置分类与作用域说明，重要配置明确保存，不在输入时自动提交。</p></div><div><strong>模型与凭据分离</strong><p>参考 Dify 的提供商和默认模型组织方式，连接信息与模型选择保持清晰。</p></div><div className="guide-links"><a href="https://linear.app/changelog/2024-12-18-personalized-sidebar" target="_blank" rel="noreferrer">Linear<ArrowUpRight size={12} /></a><a href="https://vercel.com/docs/project-configuration/project-settings" target="_blank" rel="noreferrer">Vercel<ArrowUpRight size={12} /></a><a href="https://docs.dify.ai/en/self-host/use-dify/workspace/model-providers" target="_blank" rel="noreferrer">Dify<ArrowUpRight size={12} /></a></div><p className="prototype-note">保存只更新当前页面的内存，刷新后恢复示例数据。模拟连接测试不会发送网络请求。其他导航页面暂不在本版范围内。</p></div>}
        {modal === 'config' && <><pre className="config-preview" tabIndex={0}>{previewConfig}</pre><div className="dialog-actions"><Button type="button" variant="outline" size="sm" onClick={copyConfig}><Copy />复制脱敏配置</Button><Button type="button" size="sm" onClick={() => setModal(null)}>完成</Button></div></>}
        {modal === 'review' && <><div className="change-list">{changedKeys.length ? changedKeys.map(key => <div key={key}><strong>{FIELD_LABELS[key]}</strong><div><span>{displayValue(key, saved[key])}</span><ArrowDownToLine size={13} /><b>{displayValue(key, draft[key])}</b></div></div>) : <p>当前没有未保存的更改。</p>}</div><div className="dialog-actions"><Button type="button" onClick={() => setModal(null)}>返回编辑</Button></div></>}
        {modal === 'account' && <div className="account-detail"><span className="user-avatar">A</span><div><strong>admin</strong><p>服务器管理员 · 示例身份</p></div><p>原型无需登录，不会读取你的真实登录状态。</p></div>}
        {modal === 'placeholder' && <div className="scope-empty"><LayoutGrid size={28} /><h3>这个入口已预留</h3><p>第一版完成了全局导航与系统设置。{placeholderTitle}将在设计方向确认后，沿用同一套组件继续扩展。</p><Button type="button" variant="outline" onClick={() => setModal(null)}>返回系统设置</Button></div>}
      </DialogContent></Dialog>
      {toast && <div className="prototype-toast" role="status">{toast.startsWith('还有') || toast.startsWith('浏览器') ? <CircleAlert size={17} /> : <Check size={17} />}<span>{toast}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    </div>
  )
}
