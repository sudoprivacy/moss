'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import { Check, CheckCheck, ChevronRight, CircleAlert, Copy, FileJson, Globe2, Loader2, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { SystemSettingsFields } from '@/components/settings/system-settings-fields'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getSystemSettings, updateSystemSettings } from '@/lib/api/settings'
import type { SystemSettings } from '@/lib/api/types'
import { copyToClipboard } from '@/lib/clipboard'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { buildSystemSettingsPatch, createSettingsDraft, getRedactedSettings, getSettingsChanges, TAB_FIELDS, validateSettingsDraft, type SettingsDraft, type SettingsErrors, type SettingsField, type SettingsTab } from '@/lib/system-settings'
import './system-settings.css'

const TABS = [
  { value: 'models', label: '模型配置', icon: Sparkles },
  { value: 'runtime', label: '执行与权限', icon: ShieldCheck },
  { value: 'clients', label: '客户端与集成', icon: SlidersHorizontal },
] as const

export default function SystemSettingsPage() {
  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [tab, setTab] = useState<SettingsTab>('models')
  const [errors, setErrors] = useState<SettingsErrors>({})
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [hasSaved, setHasSaved] = useState(false)
  const [modal, setModal] = useState<'review' | 'config' | null>(null)
  const [confirmSave, setConfirmSave] = useState(false)
  const loadVersion = useRef(0)
  const saveInFlight = useRef(false)
  const handlingNavigation = useRef(false)
  const { registerGuard, confirmDiscard } = useUnsavedChanges()
  const changes = settings && draft ? getSettingsChanges(settings, draft) : []
  const isDirty = changes.length > 0

  const discard = useCallback(() => {
    if (settings) setDraft(createSettingsDraft(settings))
    setErrors({})
    setSaveError('')
  }, [settings])

  useEffect(() => registerGuard({ isDirty, isSaving, discard }), [registerGuard, isDirty, isSaving, discard])
  const blocker = useBlocker(isDirty || isSaving)
  useEffect(() => {
    if (blocker.state !== 'blocked' || handlingNavigation.current) return
    handlingNavigation.current = true
    void confirmDiscard().then(confirmed => {
      if (confirmed) blocker.proceed()
      else blocker.reset()
    }).finally(() => { handlingNavigation.current = false })
  }, [blocker, confirmDiscard])

  const loadSettings = useCallback(async () => {
    const version = ++loadVersion.current
    setIsLoading(true)
    setLoadError('')
    setSaveError('')
    setErrors({})
    setSettings(null)
    setDraft(null)
    try {
      const response = await getSystemSettings()
      if (version !== loadVersion.current) return
      setSettings(response)
      setDraft(createSettingsDraft(response))
    } catch (error) {
      if (version !== loadVersion.current) return
      setLoadError(error instanceof Error ? error.message : '无法连接服务器。')
    } finally {
      if (version === loadVersion.current) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSettings()
    return () => { loadVersion.current += 1 }
  }, [loadSettings])

  function update<K extends SettingsField>(field: K, value: SettingsDraft[K]) {
    setDraft(current => current ? { ...current, [field]: value } : current)
    setErrors(current => ({ ...current, [field]: undefined }))
    setSaveError('')
    setHasSaved(false)
  }

  async function refresh() {
    if (isSaving || !(await confirmDiscard())) return
    setHasSaved(false)
    await loadSettings()
  }

  async function save() {
    if (!settings || !draft || saveInFlight.current) return
    saveInFlight.current = true
    setIsSaving(true)
    setSaveError('')
    setModal(null)
    const version = loadVersion.current
    try {
      const patch = buildSystemSettingsPatch(settings, draft)
      if (!Object.keys(patch).length) {
        setDraft(createSettingsDraft(settings))
        toast.info('配置未发生实际变化。')
        return
      }
      const response = await updateSystemSettings(patch)
      if (version !== loadVersion.current) return
      setSettings(response)
      setDraft(createSettingsDraft(response))
      setErrors({})
      setHasSaved(true)
      toast.success('系统设置已保存。')
    } catch (error) {
      if (version !== loadVersion.current) return
      setSaveError(error instanceof Error ? error.message : '请求未能完成，请稍后重试。')
      toast.error('保存失败，未保存的更改已保留。')
    } finally {
      saveInFlight.current = false
      if (version === loadVersion.current) setIsSaving(false)
    }
  }

  function requestSave() {
    if (!settings || !draft || !isDirty || settings.settingsParseError || saveInFlight.current) return
    const nextErrors = validateSettingsDraft(draft)
    setErrors(nextErrors)
    const invalidTab = TABS.find(item => TAB_FIELDS[item.value].some(field => nextErrors[field]))
    if (invalidTab) {
      setModal(null)
      setTab(invalidTab.value)
      const field = TAB_FIELDS[invalidTab.value].find(key => nextErrors[key])!
      requestAnimationFrame(() => (document.getElementById(`setting-${field}-value`) || document.getElementById(`setting-${field}`))?.focus())
      toast.error('请修正标记的字段后再保存。')
      return
    }
    if (draft.apiKey.action === 'clear' || draft.imageApiKey.action === 'clear') {
      setModal(null)
      setConfirmSave(true)
    } else {
      void save()
    }
  }

  async function copy(text: string, label: string) {
    try {
      await copyToClipboard(text)
      toast.success(`${label}已复制。`)
    } catch { toast.error('浏览器未允许复制，请手动选择文本。') }
  }

  const footer = settings && draft ? <div className="system-settings-save-bar">
    <div className="system-settings-save-status" role="status" aria-live="polite">
      {isSaving ? <Loader2 size={17} className="animate-spin" /> : saveError ? <CircleAlert size={17} /> : isDirty ? <span className="system-settings-dirty-dot" /> : <CheckCheck size={17} />}
      <div><strong>{isSaving ? '正在保存…' : saveError ? '保存失败，草稿已保留' : isDirty ? `${changes.length} 项未保存的更改` : hasSaved ? '已保存到服务器' : '没有未保存的更改'}</strong><span>适用于此服务器上的所有组织</span></div>
      {isDirty && <button type="button" className="system-settings-text-button" disabled={isSaving} onClick={() => setModal('review')}>查看更改</button>}
    </div>
    <div className="system-settings-save-actions"><Button type="button" variant="ghost" size="sm" disabled={!isDirty || isSaving} onClick={() => { void confirmDiscard() }}>取消</Button><Button type="submit" form="system-settings-form" size="sm" disabled={!isDirty || isSaving}>{isSaving ? <Loader2 className="animate-spin" /> : <Check />}保存更改</Button></div>
  </div> : undefined

  return <DashboardLayout title="系统设置" description="配置模型、执行策略与客户端默认行为。" footer={footer}>
    <div className="system-settings-page">
      <div className="system-settings-intro">
        <div><span className="system-settings-scope"><Globe2 size={14} />服务器全局配置</span><p>切换组织不会改变此处配置。</p></div>
        <div className="system-settings-toolbar-actions"><Button type="button" variant="outline" size="sm" disabled={!settings || isLoading} onClick={() => setModal('config')}><FileJson />配置详情</Button><Button type="button" variant="ghost" size="icon-sm" aria-label="重新加载设置" title="重新加载设置" disabled={isLoading || isSaving} onClick={() => void refresh()}><RefreshCw className={isLoading ? 'animate-spin' : ''} /></Button></div>
      </div>
      {isLoading ? <div className="space-y-4" aria-label="正在加载系统设置" role="status"><Skeleton className="h-10 w-full" /><Skeleton className="h-64 w-full" /><Skeleton className="h-52 w-full" /><span className="sr-only">正在加载系统设置</span></div> : loadError ? <Alert variant="destructive"><CircleAlert /><AlertTitle>无法加载系统设置</AlertTitle><AlertDescription><p>{loadError}</p><p>未加载配置前不会显示可编辑的默认值，以免覆盖服务器设置。</p><Button type="button" variant="outline" size="sm" onClick={() => void loadSettings()}>重试</Button></AlertDescription></Alert> : settings && draft ? <>
        {settings.settingsParseError && <Alert variant="destructive" className="mb-5"><CircleAlert /><AlertTitle>配置文件解析失败</AlertTitle><AlertDescription><p>当前展示服务端回退配置。为避免覆盖原配置或影响已有凭据，已暂停编辑。请在服务器修复文件后重新加载。</p><p className="break-all">{settings.settingsParseError}</p></AlertDescription></Alert>}
        {saveError && <Alert variant="destructive" className="mb-5"><CircleAlert /><AlertTitle>保存失败</AlertTitle><AlertDescription><p>{saveError}</p><p>草稿仍在当前页面。请检查连接或权限后点击“保存更改”重试。</p></AlertDescription></Alert>}
        <Tabs value={tab} onValueChange={value => setTab(value as SettingsTab)}>
          <TabsList className="system-settings-tabs" aria-label="系统设置分类">{TABS.map(item => <TabsTrigger key={item.value} value={item.value} className="system-settings-tab"><item.icon size={15} />{item.label}{TAB_FIELDS[item.value].some(field => changes.some(change => change.field === field)) && <span className="system-settings-tab-dot" aria-label="有未保存更改" />}</TabsTrigger>)}</TabsList>
          <div className="system-settings-grid">
            <form id="system-settings-form" noValidate onSubmit={event => { event.preventDefault(); requestSave() }}>
              <fieldset disabled={isSaving || Boolean(settings.settingsParseError)}><legend className="sr-only">服务器系统设置</legend><SystemSettingsFields settings={settings} draft={draft} errors={errors} update={update} /></fieldset>
              <button type="button" className="system-settings-source" onClick={() => setModal('config')}><FileJson size={15} /><span>{settings.settingsLoaded ? '已加载服务器配置' : settings.settingsExists ? '配置文件已存在' : '使用服务端默认配置'}</span><ChevronRight size={14} /></button>
            </form>
            <aside className="system-settings-rail" aria-label="设置说明">
              <div><h3>配置作用范围</h3><Globe2 size={27} className="text-primary" /><h4>一处配置，所有组织</h4><p>这里管理服务器级设置。企业名称与标志请在“企业信息配置”中管理。</p></div>
              <div><h3>在此页面</h3>{TABS.map(item => <button type="button" key={item.value} aria-current={tab === item.value ? 'true' : undefined} onClick={() => setTab(item.value)}>{item.label}<ChevronRight size={13} /></button>)}</div>
              <div><ShieldCheck size={22} className="text-primary" /><h4>凭据安全存储</h4><p>已有密钥不会填入表单。只有选择替换或清除时，才会提交密钥变更。</p><p>保存只提交变更字段；模型和运行默认值在新会话中使用。</p></div>
            </aside>
          </div>
        </Tabs>
      </> : null}
    </div>
    <Dialog open={modal !== null} onOpenChange={open => { if (!open) setModal(null) }}>
      <DialogContent className="system-settings-dialog sm:max-w-2xl"><DialogHeader><DialogTitle>{modal === 'review' ? '查看未保存的更改' : '配置详情'}</DialogTitle><DialogDescription>{modal === 'review' ? '以下更改将应用于服务器上的所有组织，密钥内容始终隐藏。' : '当前服务端配置与加载状态；不包含未保存的草稿，密钥已脱敏。'}</DialogDescription></DialogHeader>
        {modal === 'review' && <><div className="system-settings-change-list">{changes.map(change => <div key={change.field}><strong>{change.label}</strong><div><span>{change.before}</span><ChevronRight size={14} /><b>{change.after}</b></div></div>)}</div><div className="system-settings-dialog-actions"><Button type="button" variant="outline" onClick={() => setModal(null)}>返回编辑</Button><Button type="button" disabled={!isDirty || isSaving} onClick={requestSave}>保存更改</Button></div></>}
        {modal === 'config' && settings && <><div className="system-settings-config-path"><span>配置文件路径</span><code>{settings.settingsPath}</code><Button type="button" variant="ghost" size="icon-sm" aria-label="复制配置文件路径" onClick={() => void copy(settings.settingsPath, '配置文件路径')}><Copy /></Button></div><pre className="system-settings-config" tabIndex={0}>{JSON.stringify(getRedactedSettings(settings), null, 2)}</pre><div className="system-settings-dialog-actions"><Button type="button" variant="outline" onClick={() => void copy(JSON.stringify(getRedactedSettings(settings), null, 2), '脱敏配置')}><Copy />复制脱敏配置</Button></div></>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmSave} onOpenChange={setConfirmSave}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认保存重要更改</AlertDialogTitle><AlertDialogDescription>这些操作会影响服务器上使用相关配置的所有组织。</AlertDialogDescription></AlertDialogHeader><ul className="list-disc space-y-2 pl-5 text-sm">{draft?.apiKey.action === 'clear' && <li>删除已保存的文本模型 API Key。</li>}{draft?.imageApiKey.action === 'clear' && <li>删除已保存的图片模型 API Key。</li>}</ul><AlertDialogFooter><AlertDialogCancel>返回检查</AlertDialogCancel><AlertDialogAction onClick={() => void save()}>确认保存</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </DashboardLayout>
}
