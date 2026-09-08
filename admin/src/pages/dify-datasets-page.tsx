'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, ExternalLink, FilePlus2, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { difyDatasetsApi, type DifyDataset, type DifyDocument } from '@/lib/api/dify-datasets'
import { useAuth } from '@/lib/hooks/use-auth'

type DatasetDialog = { mode: 'create' | 'edit'; item?: DifyDataset } | null
type DocumentDialog = { mode: 'text' | 'file'; dataset: DifyDataset } | null

export default function DifyDatasetsPage() {
  const { activeOrganization } = useAuth()
  const enterpriseId = activeOrganization?.legacyId ?? null
  const [datasets, setDatasets] = useState<DifyDataset[]>([])
  const [documents, setDocuments] = useState<DifyDocument[]>([])
  const [selected, setSelected] = useState<DifyDataset | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [datasetDialog, setDatasetDialog] = useState<DatasetDialog>(null)
  const [documentDialog, setDocumentDialog] = useState<DocumentDialog>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [indexing, setIndexing] = useState('high_quality')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [retrieveQuery, setRetrieveQuery] = useState('')
  const [retrieveResult, setRetrieveResult] = useState<unknown>(null)

  const loadDatasets = useCallback(async () => {
    if (!enterpriseId) return
    setLoading(true)
    try {
      const response = await difyDatasetsApi.list(enterpriseId, { page: 1, limit: 100, keyword: keyword.trim() || undefined })
      setDatasets(listOf<DifyDataset>(response.data))
    } catch (error) { toast.error(error instanceof Error ? error.message : '获取 Dify 数据集失败') }
    finally { setLoading(false) }
  }, [enterpriseId, keyword])

  const loadDocuments = useCallback(async (dataset: DifyDataset) => {
    if (!enterpriseId) return
    try { setDocuments(listOf<DifyDocument>((await difyDatasetsApi.listDocuments(enterpriseId, dataset.id, { page: 1, limit: 100 })).data)) }
    catch (error) { toast.error(error instanceof Error ? error.message : '获取文档失败') }
  }, [enterpriseId])

  useEffect(() => { void loadDatasets() }, [loadDatasets])
  useEffect(() => { if (selected) void loadDocuments(selected); else setDocuments([]) }, [loadDocuments, selected])

  const openDataset = (mode: 'create' | 'edit', item?: DifyDataset) => {
    setDatasetDialog({ mode, item }); setName(item?.name ?? ''); setDescription(String(item?.description ?? '')); setIndexing(String(item?.indexing_technique ?? 'high_quality'))
  }

  const saveDataset = async () => {
    if (!enterpriseId || !datasetDialog || !name.trim()) return
    setSaving(true)
    try {
      if (datasetDialog.mode === 'create') await difyDatasetsApi.create(enterpriseId, { name: name.trim(), description: description.trim() || undefined, indexingTechnique: indexing })
      else if (datasetDialog.item) await difyDatasetsApi.update(enterpriseId, datasetDialog.item.id, { name: name.trim(), description: description.trim() || undefined })
      toast.success(datasetDialog.mode === 'create' ? '数据集已创建' : '数据集已更新')
      setDatasetDialog(null); await loadDatasets()
    } catch (error) { toast.error(error instanceof Error ? error.message : '保存数据集失败') }
    finally { setSaving(false) }
  }

  const removeDataset = async (item: DifyDataset) => {
    if (!enterpriseId || !window.confirm(`确认删除数据集 ${item.name} 及其全部文档？`)) return
    try { await difyDatasetsApi.delete(enterpriseId, item.id); if (selected?.id === item.id) setSelected(null); toast.success('数据集已删除'); await loadDatasets() }
    catch (error) { toast.error(error instanceof Error ? error.message : '删除失败') }
  }

  const saveDocument = async () => {
    if (!enterpriseId || !documentDialog) return
    setSaving(true)
    try {
      if (documentDialog.mode === 'text') {
        if (!name.trim() || !text.trim()) throw new Error('名称和内容不能为空')
        await difyDatasetsApi.createTextDocument(enterpriseId, documentDialog.dataset.id, { name: name.trim(), text, indexingTechnique: indexing })
      } else {
        if (!file) throw new Error('请选择文件')
        const form = new FormData(); form.set('file', file); form.set('indexing_technique', indexing)
        await difyDatasetsApi.createFileDocument(enterpriseId, documentDialog.dataset.id, form)
      }
      toast.success('文档已创建'); setDocumentDialog(null); setFile(null); setText(''); await loadDocuments(documentDialog.dataset)
    } catch (error) { toast.error(error instanceof Error ? error.message : '创建文档失败') }
    finally { setSaving(false) }
  }

  const removeDocument = async (item: DifyDocument) => {
    if (!enterpriseId || !selected || !window.confirm('确认删除该文档？')) return
    try { await difyDatasetsApi.deleteDocument(enterpriseId, selected.id, item.id); toast.success('文档已删除'); await loadDocuments(selected) }
    catch (error) { toast.error(error instanceof Error ? error.message : '删除文档失败') }
  }

  const retrieve = async () => {
    if (!enterpriseId || !selected || !retrieveQuery.trim()) return
    setSaving(true)
    try { setRetrieveResult((await difyDatasetsApi.retrieve(enterpriseId, selected.id, retrieveQuery.trim())).data) }
    catch (error) { toast.error(error instanceof Error ? error.message : '检索失败') }
    finally { setSaving(false) }
  }

  const openStudio = async () => {
    if (!enterpriseId) return
    try {
      const response = await difyDatasetsApi.getStudioLink(enterpriseId, '/datasets')
      const url = response.data.url
      if (!url) throw new Error('Dify Studio 地址为空')
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) { toast.error(error instanceof Error ? error.message : '打开 Dify Studio 失败') }
  }

  const selectedName = useMemo(() => selected?.name ?? '未选择数据集', [selected])
  return (
    <DashboardLayout title="Dify 数据集" description="管理当前组织的 Dify 知识库、文档和检索验证">
      <div className="grid gap-5 xl:grid-cols-[minmax(340px,0.8fr)_minmax(0,1.4fr)]">
        <section className="space-y-3">
          <div className="flex gap-2"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索数据集" /></div><Button variant="outline" size="icon" title="Dify Studio" onClick={() => void openStudio()}><ExternalLink className="size-4" /></Button><Button variant="outline" size="icon" title="刷新" onClick={() => void loadDatasets()}><RefreshCw className="size-4" /></Button><Button size="icon" title="新建数据集" onClick={() => openDataset('create')}><Plus className="size-4" /></Button></div>
          <div className="overflow-hidden rounded-md border"><Table><TableHeader><TableRow><TableHead>数据集</TableHead><TableHead>文档</TableHead><TableHead className="w-24">操作</TableHead></TableRow></TableHeader><TableBody>{loading ? Array.from({ length: 5 }, (_, index) => <TableRow key={index}><TableCell colSpan={3}><Skeleton className="h-8" /></TableCell></TableRow>) : datasets.map(item => <TableRow key={item.id} className={selected?.id === item.id ? 'bg-muted/50' : ''}><TableCell><button className="text-left font-medium" onClick={() => setSelected(item)}>{item.name}</button><div className="max-w-64 truncate text-xs text-muted-foreground">{String(item.description ?? '')}</div></TableCell><TableCell>{String(item.document_count ?? item.documentCount ?? '-')}</TableCell><TableCell><div className="flex gap-1"><Button variant="ghost" size="icon" title="编辑" onClick={() => openDataset('edit', item)}><Pencil className="size-4" /></Button><Button variant="ghost" size="icon" title="删除" onClick={() => void removeDataset(item)}><Trash2 className="size-4" /></Button></div></TableCell></TableRow>)}</TableBody></Table></div>
        </section>
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">{selectedName}</h2><p className="text-sm text-muted-foreground">{selected ? `${documents.length} 个文档` : '从左侧选择一个数据集'}</p></div>{selected ? <div className="flex gap-2"><Button variant="outline" onClick={() => { setName(''); setText(''); setIndexing('high_quality'); setDocumentDialog({ mode: 'text', dataset: selected }) }}><FilePlus2 className="mr-2 size-4" />文本</Button><Button variant="outline" onClick={() => { setFile(null); setIndexing('high_quality'); setDocumentDialog({ mode: 'file', dataset: selected }) }}><Upload className="mr-2 size-4" />上传</Button></div> : null}</div>
          {selected ? <><div className="overflow-hidden rounded-md border"><Table><TableHeader><TableRow><TableHead>文档</TableHead><TableHead>状态</TableHead><TableHead>字数</TableHead><TableHead className="w-16" /></TableRow></TableHeader><TableBody>{documents.map(item => <TableRow key={item.id}><TableCell>{String(item.name ?? item.id)}</TableCell><TableCell>{String(item.indexing_status ?? item.status ?? '-')}</TableCell><TableCell>{String(item.word_count ?? '-')}</TableCell><TableCell><Button variant="ghost" size="icon" title="删除" onClick={() => void removeDocument(item)}><Trash2 className="size-4" /></Button></TableCell></TableRow>)}{documents.length === 0 ? <TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">暂无文档</TableCell></TableRow> : null}</TableBody></Table></div><div className="space-y-2 rounded-md border p-4"><Label htmlFor="dataset-query">检索测试</Label><div className="flex gap-2"><Input id="dataset-query" value={retrieveQuery} onChange={event => setRetrieveQuery(event.target.value)} placeholder="输入查询内容" /><Button onClick={() => void retrieve()} disabled={saving}>检索</Button></div>{retrieveResult ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{JSON.stringify(retrieveResult, null, 2)}</pre> : null}</div></> : <div className="flex min-h-72 flex-col items-center justify-center rounded-md border border-dashed text-muted-foreground"><Database className="mb-3 size-8" />请选择数据集</div>}
        </section>
      </div>

      <Dialog open={datasetDialog !== null} onOpenChange={open => { if (!open) setDatasetDialog(null) }}><DialogContent><DialogHeader><DialogTitle>{datasetDialog?.mode === 'create' ? '新建数据集' : '编辑数据集'}</DialogTitle></DialogHeader><div className="space-y-4"><Field label="名称"><Input value={name} onChange={event => setName(event.target.value)} /></Field><Field label="描述"><Textarea value={description} onChange={event => setDescription(event.target.value)} /></Field>{datasetDialog?.mode === 'create' ? <Field label="索引方式"><Select value={indexing} onValueChange={setIndexing}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="high_quality">高质量</SelectItem><SelectItem value="economy">经济模式</SelectItem></SelectContent></Select></Field> : null}</div><DialogFooter><Button variant="outline" onClick={() => setDatasetDialog(null)}>取消</Button><Button disabled={saving || !name.trim()} onClick={() => void saveDataset()}>{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}保存</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={documentDialog !== null} onOpenChange={open => { if (!open) setDocumentDialog(null) }}><DialogContent><DialogHeader><DialogTitle>{documentDialog?.mode === 'text' ? '新建文本文档' : '上传文档'}</DialogTitle><DialogDescription>{documentDialog?.dataset.name}</DialogDescription></DialogHeader><div className="space-y-4">{documentDialog?.mode === 'text' ? <><Field label="名称"><Input value={name} onChange={event => setName(event.target.value)} /></Field><Field label="内容"><Textarea rows={10} value={text} onChange={event => setText(event.target.value)} /></Field></> : <Field label="文件"><Input type="file" onChange={event => setFile(event.target.files?.[0] ?? null)} /></Field>}<Field label="索引方式"><Select value={indexing} onValueChange={setIndexing}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="high_quality">高质量</SelectItem><SelectItem value="economy">经济模式</SelectItem></SelectContent></Select></Field></div><DialogFooter><Button variant="outline" onClick={() => setDocumentDialog(null)}>取消</Button><Button disabled={saving} onClick={() => void saveDocument()}>{saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}创建</Button></DialogFooter></DialogContent></Dialog>
    </DashboardLayout>
  )
}

function listOf<T extends Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of ['data', 'items', 'list']) if (Array.isArray(record[key])) return record[key] as T[]
  return []
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>
}
