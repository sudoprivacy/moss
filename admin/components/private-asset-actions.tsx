import { useRef, useState } from 'react'
import { PublicationSubmitButton } from './publication-submit-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/api/client'
import { downloadAssistant } from '@/lib/api/agent-hub'
import { downloadSkill } from '@/lib/api/skill-store'

export function PrivateAssetActions({ kind, id, name, version, onSubmitted, source = 'installed', canSubmit = true }: { kind: 'agent' | 'skill'; id: string; name: string; version?: string; onSubmitted: () => Promise<unknown>; source?: 'installed' | 'tenant'; canSubmit?: boolean }) {
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [edit, setEdit] = useState<{ content: string; displayName: string; description: string } | null>(null)
  async function importVersion(file?: File) {
    if (!file) return
    setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let text = ''
      for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      const fileBase64 = btoa(text)
      await authClient.post(kind === 'agent' ? '/api/v1/agent-templates/custom' : '/api/v1/skills/import/archive', kind === 'agent' ? { targetId: id, file: fileBase64, name } : { targetId: id, archiveBase64: fileBase64, fileName: file.name })
      toast.success('已更新我的工作稿，提交审核后才会更新发布版本')
      await onSubmitted()
    } catch (error) { toast.error(error instanceof Error ? error.message : '导入失败') }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }

  async function exportAsset() {
    setBusy(true)
    try {
        const blob = kind === 'agent' ? await downloadAssistant(id, source) : await downloadSkill(id, source)
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `${name}.zip`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { toast.error(error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false) }
  }
  return <><div className="flex justify-end gap-2 pt-2">
    {source === 'installed' ? <>
      <input ref={fileInput} className="hidden" type="file" accept=".zip" aria-label="导入新版本" onChange={event => void importVersion(event.target.files?.[0])} />
      <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>导入新版本</Button>
      {kind === 'skill' ? <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { setEdit(await authClient.get(`/api/v1/skills/custom/${encodeURIComponent(id)}`)) } catch (error) { toast.error(String(error)) } finally { setBusy(false) } }}>编辑</Button> : null}
    </> : null}
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportAsset()}>导出</Button>
    {canSubmit ? <PublicationSubmitButton disabled={busy}
      loadPreview={() => authClient.get(`/api/v1/${kind === 'agent' ? 'agent-templates' : 'skills'}/tenant/publication-preview?id=${encodeURIComponent(id)}`)}
      onSubmit={async (version, publishNote) => {
        await authClient.post(`/api/v1/${kind === 'agent' ? 'agent-templates' : 'skills'}/tenant/publish`, { ...(kind === 'agent' ? { assistantId: id } : { skillId: id }), version, publishNote })
        await onSubmitted()
      }} /> : null}
  </div>
    <Dialog open={edit !== null} onOpenChange={open => { if (!open && !busy) setEdit(null) }}><DialogContent><DialogHeader><DialogTitle>编辑我的技能</DialogTitle></DialogHeader>
      {version ? <p className="text-sm text-muted-foreground">当前版本：{version}</p> : null}
      {edit ? <><label>显示名称<Input value={edit.displayName} onChange={event => setEdit({ ...edit, displayName: event.target.value })} /></label><label>描述<Textarea value={edit.description} onChange={event => setEdit({ ...edit, description: event.target.value })} /></label><label>技能内容<Textarea rows={14} value={edit.content} onChange={event => setEdit({ ...edit, content: event.target.value })} /></label></> : null}
      <DialogFooter><Button disabled={busy || !edit?.content.trim() || !edit.displayName.trim()} onClick={async () => { if (!edit) return; setBusy(true); try { await authClient.patch(`/api/v1/skills/custom/${encodeURIComponent(id)}`, edit); setEdit(null); await onSubmitted(); toast.success('工作稿已保存，请提交审核') } catch (error) { toast.error(String(error)) } finally { setBusy(false) } }}>保存</Button></DialogFooter>
    </DialogContent></Dialog>
  </>
}

export function EditPublishedAsset({ kind, id, source = 'hub', onDraft }: { kind: 'agents' | 'skills'; id: string; source?: 'hub' | 'tenant'; onDraft: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return <Button size="sm" variant="outline" disabled={busy} onClick={async event => {
    event.stopPropagation()
    setBusy(true)
    try {
      const draft = await authClient.post<{ id: string }>(`/api/v1/catalog/${kind}/${source}/${encodeURIComponent(id)}/draft`, {})
      await onDraft(draft.id)
    } catch (error) { toast.error(error instanceof Error ? error.message : '读取可编辑版本失败') }
    finally { setBusy(false) }
  }}>{busy ? '读取中…' : '编辑'}</Button>
}
