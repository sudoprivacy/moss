import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderTree,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Library,
  Sparkles,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'

import { DashboardLayout } from '@/components/dashboard-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

import {
  type DocumentRecord,
  type DocumentTreeNode,
  type WikiRecord,
  createDocumentTreeNode,
  createWiki,
  deleteDocument,
  deleteDocumentTreeNode,
  deleteWiki,
  fileToBase64,
  getDocumentTree,
  getWikiBuildStatus,
  listDocumentsForNode,
  listWikis,
  setDocumentTreeNodeAlias,
  subscribeWikiBuildEvents,
  triggerWikiBuild,
  updateDocumentTreeNode,
  uploadDocument,
} from '@/lib/api/document-center'

const MAX_DOC_SIZE = 50 * 1024 * 1024 // 50 MB; aligns with server-side limit

// ============================================================
// Tree helpers
// ============================================================

type DocTreeBranch = DocumentTreeNode & { children: DocTreeBranch[] }

function buildTree(nodes: DocumentTreeNode[]): DocTreeBranch[] {
  const byId = new Map<string, DocTreeBranch>()
  for (const n of nodes) byId.set(n.id, { ...n, children: [] })
  const roots: DocTreeBranch[] = []
  for (const n of nodes) {
    const branch = byId.get(n.id)!
    if (n.parentId && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(branch)
    } else {
      roots.push(branch)
    }
  }
  const sortBranches = (list: DocTreeBranch[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    for (const b of list) sortBranches(b.children)
  }
  sortBranches(roots)
  return roots
}

// ============================================================
// Page
// ============================================================

export default function DocumentCenterPage() {
  const [nodes, setNodes] = useState<DocumentTreeNode[]>([])
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [wikis, setWikis] = useState<WikiRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Dialog states
  const [createNodeOpen, setCreateNodeOpen] = useState(false)
  const [createNodeParent, setCreateNodeParent] = useState<DocumentTreeNode | null>(null)
  const [newNodeName, setNewNodeName] = useState('')
  const [newNodeDesc, setNewNodeDesc] = useState('')

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<DocumentTreeNode | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DocumentTreeNode | null>(null)

  // v2: alias dialog for auto_managed nodes.
  const [aliasOpen, setAliasOpen] = useState(false)
  const [aliasTarget, setAliasTarget] = useState<DocumentTreeNode | null>(null)
  const [aliasValue, setAliasValue] = useState('')

  const [createWikiOpen, setCreateWikiOpen] = useState(false)
  const [wikiName, setWikiName] = useState('')
  const [wikiDesc, setWikiDesc] = useState('')
  const [wikiSourceDocIds, setWikiSourceDocIds] = useState<Set<string>>(new Set())

  const tree = useMemo(() => buildTree(nodes), [nodes])
  const selectedNode = useMemo(
    () => nodes.find(n => n.id === selectedId) ?? null,
    [nodes, selectedId],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [t, w] = await Promise.all([getDocumentTree(), listWikis()])
      setNodes(t)
      setWikis(w)
      // Auto-expand all on first load so user sees the structure
      setExpanded(prev => {
        if (prev.size === 0 && t.length > 0) {
          return new Set(t.map(n => n.id))
        }
        return prev
      })
    } catch (err) {
      toast.error(`加载文档中心失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Load documents/wikis filtered by selected node when selection changes
  useEffect(() => {
    if (!selectedId) {
      setDocuments([])
      return
    }
    void listDocumentsForNode(selectedId)
      .then(setDocuments)
      .catch(err => {
        toast.error(`加载文档失败：${err instanceof Error ? err.message : String(err)}`)
      })
  }, [selectedId])

  const wikisForNode = useMemo(() => {
    if (!selectedId) return []
    return wikis.filter(w => w.nodeId === selectedId)
  }, [wikis, selectedId])

  // ---------- Tree handlers ----------

  const toggleExpand = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleOpenCreateRoot = () => {
    setCreateNodeParent(null)
    setNewNodeName('')
    setNewNodeDesc('')
    setCreateNodeOpen(true)
  }

  const handleOpenCreateChild = (parent: DocumentTreeNode) => {
    setCreateNodeParent(parent)
    setNewNodeName('')
    setNewNodeDesc('')
    setCreateNodeOpen(true)
  }

  const handleCreateNode = async () => {
    const name = newNodeName.trim()
    if (!name) {
      toast.error('请输入节点名称')
      return
    }
    try {
      const created = await createDocumentTreeNode({
        parent_id: createNodeParent?.id ?? null,
        name,
        description: newNodeDesc.trim() || undefined,
      })
      setCreateNodeOpen(false)
      if (createNodeParent) {
        setExpanded(prev => new Set(prev).add(createNodeParent.id))
      }
      await refresh()
      setSelectedId(created.id)
      toast.success('节点已创建')
    } catch (err) {
      toast.error(`创建失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleOpenRename = (node: DocumentTreeNode) => {
    setRenameTarget(node)
    setRenameValue(node.name)
    setRenameOpen(true)
  }

  const handleRename = async () => {
    if (!renameTarget) return
    const name = renameValue.trim()
    if (!name) {
      toast.error('请输入节点名称')
      return
    }
    try {
      await updateDocumentTreeNode(renameTarget.id, { name })
      setRenameOpen(false)
      await refresh()
      toast.success('节点已重命名')
    } catch (err) {
      toast.error(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleOpenDelete = (node: DocumentTreeNode) => {
    setDeleteTarget(node)
    setDeleteOpen(true)
  }

  const handleOpenSetAlias = (node: DocumentTreeNode) => {
    setAliasTarget(node)
    setAliasValue(node.alias ?? '')
    setAliasOpen(true)
  }

  const handleSetAlias = async () => {
    if (!aliasTarget) return
    try {
      const next = aliasValue.trim()
      await setDocumentTreeNodeAlias(aliasTarget.id, next || null)
      setAliasOpen(false)
      await refresh()
      toast.success('已更新别名')
    } catch (err) {
      toast.error(`更新失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleDeleteNode = async () => {
    if (!deleteTarget) return
    try {
      await deleteDocumentTreeNode(deleteTarget.id)
      setDeleteOpen(false)
      if (selectedId === deleteTarget.id) setSelectedId(null)
      await refresh()
      toast.success('节点已删除')
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---------- Document handlers ----------

  const handleUploadDocument = async (file: File) => {
    if (!selectedId) return
    if (file.size > MAX_DOC_SIZE) {
      toast.error(`文件超过 50MB 上限：${file.name}`)
      return
    }
    try {
      const content_base64 = await fileToBase64(file)
      await uploadDocument(selectedId, {
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        content_base64,
      })
      const next = await listDocumentsForNode(selectedId)
      setDocuments(next)
      toast.success(`已上传：${file.name}`)
    } catch (err) {
      toast.error(`上传失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleDeleteDocument = async (docId: string) => {
    try {
      await deleteDocument(docId)
      if (selectedId) {
        setDocuments(await listDocumentsForNode(selectedId))
      }
      toast.success('文档已删除')
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---------- Wiki handlers ----------

  const handleOpenCreateWiki = () => {
    setWikiName('')
    setWikiDesc('')
    setWikiSourceDocIds(new Set(documents.map(d => d.id)))
    setCreateWikiOpen(true)
  }

  const handleCreateWiki = async () => {
    if (!selectedId) return
    const name = wikiName.trim()
    if (!name) {
      toast.error('请输入 Wiki 名称')
      return
    }
    if (wikiSourceDocIds.size === 0) {
      toast.error('请至少选择一个源文档')
      return
    }
    try {
      const wiki = await createWiki({
        name,
        description: wikiDesc.trim() || undefined,
        node_id: selectedId,
        source_document_ids: Array.from(wikiSourceDocIds),
      })
      setCreateWikiOpen(false)
      setWikis(prev => [wiki, ...prev])
      toast.success(`Wiki 已创建：${wiki.name}`)
    } catch (err) {
      toast.error(`创建失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleBuildWiki = async (wiki: WikiRecord) => {
    try {
      await triggerWikiBuild(wiki.id)
      toast.success('Build 任务已入队')
      // Optimistic: mark pending so UI shows "构建中"
      setWikis(prev => prev.map(w => (w.id === wiki.id ? { ...w, buildStatus: 'pending' } : w)))
      // Live progress via SSE (auto-stops on done/failed)
      const unsubscribe = subscribeWikiBuildEvents(wiki.id, {
        onProgress: (data) => {
          setWikis(prev =>
            prev.map(w =>
              w.id === wiki.id
                ? {
                    ...w,
                    buildStatus:
                      data.wiki_build_status === 'unknown'
                        ? w.buildStatus
                        : (data.wiki_build_status as WikiRecord['buildStatus']),
                    lastBuiltAt: data.last_built_at,
                    lastBuildError: data.last_build_error,
                  }
                : w,
            ),
          )
        },
        onDone: () => {
          // Fetch once more to capture final state authoritatively.
          void getWikiBuildStatus(wiki.id).then((status) => {
            setWikis(prev =>
              prev.map(w =>
                w.id === wiki.id
                  ? {
                      ...w,
                      buildStatus: status.wiki_build_status,
                      lastBuiltAt: status.last_built_at,
                      lastBuildError: status.last_build_error,
                    }
                  : w,
              ),
            )
            if (status.wiki_build_status === 'succeeded') {
              toast.success(`Wiki「${wiki.name}」构建完成`)
            } else if (status.wiki_build_status === 'failed') {
              toast.error(`Wiki「${wiki.name}」构建失败：${status.last_build_error ?? '未知错误'}`)
            }
          })
        },
        onError: () => {
          // SSE may close on its own when the server-side build finishes.
          // Treat errors as a fallback by polling once.
          void getWikiBuildStatus(wiki.id).then((status) => {
            setWikis(prev =>
              prev.map(w =>
                w.id === wiki.id
                  ? {
                      ...w,
                      buildStatus: status.wiki_build_status,
                      lastBuiltAt: status.last_built_at,
                      lastBuildError: status.last_build_error,
                    }
                  : w,
              ),
            )
          })
        },
      })
      // Safety net: if SSE doesn't get a terminal event in 10 minutes,
      // cut the subscription. Build worker also has a 30-min hard cap.
      window.setTimeout(unsubscribe, 10 * 60_000)
    } catch (err) {
      toast.error(`Build 触发失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleDeleteWiki = async (wiki: WikiRecord) => {
    if (!window.confirm(`确认删除 Wiki「${wiki.name}」？此操作不可恢复。`)) return
    try {
      await deleteWiki(wiki.id)
      setWikis(prev => prev.filter(w => w.id !== wiki.id))
      toast.success('Wiki 已删除')
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ============================================================
  // Render
  // ============================================================

  return (
    <DashboardLayout title="文档中心" description="管理企业知识库：组织文档树、构建 Wiki、授权给智能体">
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        {/* Tree column */}
        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 py-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FolderTree className="size-4" />
              文档树
            </CardTitle>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" onClick={() => void refresh()} title="刷新">
                <RefreshCw className="size-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={handleOpenCreateRoot}>
                <Plus className="mr-1 size-4" />
                新建一级节点
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto p-2">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                加载中…
              </div>
            ) : tree.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                还没有文档树节点。点击右上角「新建一级节点」开始。
              </div>
            ) : (
              <ul className="space-y-1">
                {tree.map(branch => (
                  <TreeRow
                    key={branch.id}
                    branch={branch}
                    depth={0}
                    expanded={expanded}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onToggle={toggleExpand}
                    onCreateChild={handleOpenCreateChild}
                    onRename={handleOpenRename}
                    onDelete={handleOpenDelete}
                    onSetAlias={handleOpenSetAlias}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Detail column */}
        <Card className="flex flex-col">
          <CardHeader className="py-3">
            <CardTitle className="text-base flex items-center gap-2">
              {selectedNode ? (
                <>
                  <FolderTree className="size-4" />
                  {selectedNode.name}
                </>
              ) : (
                <>
                  <FolderTree className="size-4" />
                  请在左侧选择一个节点
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto space-y-6">
            {!selectedNode ? (
              <div className="rounded-md border border-dashed p-12 text-center text-sm text-muted-foreground">
                选择左侧任意节点，即可在此管理该节点下的文档与 Wiki。
              </div>
            ) : (
              <>
                {selectedNode.description && (
                  <p className="text-sm text-muted-foreground">{selectedNode.description}</p>
                )}

                {/* Documents */}
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium flex items-center gap-2">
                      <FileText className="size-4" />
                      文档（{documents.length}）
                    </h3>
                    <div>
                      <input
                        id="doc-upload-input"
                        type="file"
                        multiple
                        className="hidden"
                        onChange={async (e) => {
                          const files = Array.from(e.target.files ?? [])
                          for (const f of files) {
                            await handleUploadDocument(f)
                          }
                          e.target.value = '' // reset so same file can re-upload
                        }}
                      />
                      <Button asChild size="sm" variant="outline">
                        <label htmlFor="doc-upload-input" className="cursor-pointer">
                          <Upload className="mr-2 size-4" />
                          上传文档
                        </label>
                      </Button>
                    </div>
                  </div>
                  {documents.length === 0 ? (
                    <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                      该节点下还没有文档，点击右上角「上传文档」(支持 docx/pdf/md/txt，单文件 ≤ 50MB)。
                    </div>
                  ) : (
                    <ul className="divide-y rounded-md border">
                      {documents.map(doc => (
                        <li key={doc.id} className="flex items-center justify-between gap-3 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{doc.fileName}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatSize(doc.sizeBytes)} ·{' '}
                              {new Date(doc.uploadedAt).toLocaleString('zh-CN')}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void handleDeleteDocument(doc.id)}
                            title="删除"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Wikis */}
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium flex items-center gap-2">
                      <Library className="size-4" />
                      Wiki（基于本节点文档构建，{wikisForNode.length}）
                    </h3>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleOpenCreateWiki}
                      disabled={documents.length === 0}
                    >
                      <Plus className="mr-2 size-4" />
                      新建 Wiki
                    </Button>
                  </div>
                  {wikisForNode.length === 0 ? (
                    <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                      该节点下还没有 Wiki。先上传文档，再「新建 Wiki」由 AI 构建子知识库。
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {wikisForNode.map(wiki => (
                        <Card key={wiki.id}>
                          <CardContent className="space-y-2 p-4">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-medium">{wiki.name}</p>
                              <div className="flex items-center gap-1.5">
                                {wiki.needsRebuild && (
                                  <Badge
                                    variant="secondary"
                                    className="bg-amber-100 text-amber-700 border-amber-200"
                                    title="源文档已更新,建议重新构建以获取最新内容"
                                  >
                                    建议重建
                                  </Badge>
                                )}
                                <WikiStatusBadge status={wiki.buildStatus} />
                              </div>
                            </div>
                            {wiki.description && (
                              <p className="text-xs text-muted-foreground">{wiki.description}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              源文档 {wiki.sourceDocumentIds.length} 份 ·{' '}
                              {wiki.lastBuiltAt
                                ? `上次构建 ${new Date(wiki.lastBuiltAt).toLocaleString('zh-CN')}`
                                : '尚未构建'}
                            </p>
                            {wiki.lastBuildError && (
                              <p className="text-xs text-destructive">
                                构建错误：{wiki.lastBuildError}
                              </p>
                            )}
                            <div className="flex gap-2 pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void handleBuildWiki(wiki)}
                              >
                                <Sparkles className="mr-2 size-4" />
                                {wiki.buildStatus === 'succeeded' ? '重新构建' : '构建'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void handleDeleteWiki(wiki)}
                              >
                                <Trash2 className="mr-2 size-4" />
                                删除
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create node dialog */}
      <Dialog open={createNodeOpen} onOpenChange={setCreateNodeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {createNodeParent ? `在「${createNodeParent.name}」下新建子节点` : '新建一级节点'}
            </DialogTitle>
            <DialogDescription>
              文档树节点用于组织文档；可按产品 / 项目 / 业务模块灵活分组。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="node-name">名称</Label>
              <Input
                id="node-name"
                value={newNodeName}
                onChange={e => setNewNodeName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="node-desc">描述（可选）</Label>
              <Textarea
                id="node-desc"
                value={newNodeDesc}
                onChange={e => setNewNodeDesc(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateNodeOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreateNode()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名节点</DialogTitle>
          </DialogHeader>
          <div className="space-y-1 py-2">
            <Label htmlFor="rename-input">名称</Label>
            <Input
              id="rename-input"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleRename()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* v2: Alias dialog (auto_managed nodes) */}
      <Dialog open={aliasOpen} onOpenChange={setAliasOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>设置显示别名</DialogTitle>
            <DialogDescription>
              「{aliasTarget?.name}」由外部数据源同步,原名不可改。在此设置一个仅用于展示的别名,清空则恢复原名。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 py-2">
            <Label htmlFor="alias-input">别名</Label>
            <Input
              id="alias-input"
              value={aliasValue}
              onChange={e => setAliasValue(e.target.value)}
              placeholder="例如:运营 SOP(锐锢)"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAliasOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSetAlias()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除节点 「{deleteTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              该操作会递归删除所有子节点 + 节点下的所有文档。Wiki 的源文档引用会失效。**操作不可恢复。**
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteNode()}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create wiki dialog */}
      <Dialog open={createWikiOpen} onOpenChange={setCreateWikiOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建 Wiki</DialogTitle>
            <DialogDescription>
              从当前节点的文档中选择一组，AI 会把它们整理成一个子知识库（含多份 md + 总结）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="wiki-name">名称</Label>
              <Input
                id="wiki-name"
                value={wikiName}
                onChange={e => setWikiName(e.target.value)}
                placeholder="例如：返厂业务 Wiki"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wiki-desc">描述（可选；会成为 Agent 看到的 INDEX 描述）</Label>
              <Textarea
                id="wiki-desc"
                value={wikiDesc}
                onChange={e => setWikiDesc(e.target.value)}
                rows={2}
                placeholder="例如：涵盖返厂申请、物流追踪、售后异常处理流程"
              />
            </div>
            <div className="space-y-1">
              <Label>源文档（{wikiSourceDocIds.size} / {documents.length} 选中）</Label>
              <div className="max-h-48 overflow-auto rounded border p-2 space-y-1">
                {documents.map(doc => (
                  <label key={doc.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={wikiSourceDocIds.has(doc.id)}
                      onCheckedChange={(checked) => {
                        setWikiSourceDocIds(prev => {
                          const next = new Set(prev)
                          if (checked) next.add(doc.id)
                          else next.delete(doc.id)
                          return next
                        })
                      }}
                    />
                    <span className="truncate">{doc.fileName}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatSize(doc.sizeBytes)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateWikiOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreateWiki()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}

// ============================================================
// TreeRow
// ============================================================

function TreeRow({
  branch,
  depth,
  expanded,
  selectedId,
  onSelect,
  onToggle,
  onCreateChild,
  onRename,
  onDelete,
  onSetAlias,
}: {
  branch: DocTreeBranch
  depth: number
  expanded: Set<string>
  selectedId: string | null
  onSelect: (id: string) => void
  onToggle: (id: string) => void
  onCreateChild: (n: DocumentTreeNode) => void
  onRename: (n: DocumentTreeNode) => void
  onDelete: (n: DocumentTreeNode) => void
  onSetAlias: (n: DocumentTreeNode) => void
}) {
  const hasChildren = branch.children.length > 0
  const isExpanded = expanded.has(branch.id)
  const isSelected = selectedId === branch.id
  const isAuto = branch.autoManaged === true
  const displayName = isAuto && branch.alias ? `${branch.alias} (${branch.name})` : branch.name

  return (
    <li>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-md px-2 py-1 cursor-pointer hover:bg-accent',
          isSelected && 'bg-primary/10 text-primary',
          isAuto && 'opacity-90',
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => onSelect(branch.id)}
      >
        <button
          type="button"
          className="shrink-0 inline-flex items-center justify-center size-5 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            if (hasChildren) onToggle(branch.id)
          }}
          aria-label={isExpanded ? '折叠' : '展开'}
        >
          {hasChildren ? (
            isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />
          ) : (
            <span className="inline-block size-4" />
          )}
        </button>
        {isAuto && (
          <Lock
            className="size-3 text-muted-foreground shrink-0"
            aria-label="自动同步节点(不可改名/删除)"
          />
        )}
        <span className="flex-1 truncate text-sm">{displayName}</span>
        {hasChildren && (
          <Badge variant="outline" className="ml-1">
            {branch.children.length}
          </Badge>
        )}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5">
          {!isAuto && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={(e) => {
                e.stopPropagation()
                onCreateChild(branch)
              }}
              title="新建子节点"
            >
              <Plus className="size-3.5" />
            </Button>
          )}
          {isAuto ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={(e) => {
                e.stopPropagation()
                onSetAlias(branch)
              }}
              title="设置显示别名"
            >
              <Pencil className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={(e) => {
                e.stopPropagation()
                onRename(branch)
              }}
              title="重命名"
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {!isAuto && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(branch)
              }}
              title="删除"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {hasChildren && isExpanded && (
        <ul className="space-y-0.5">
          {branch.children.map(child => (
            <TreeRow
              key={child.id}
              branch={child}
              depth={depth + 1}
              expanded={expanded}
              selectedId={selectedId}
              onSelect={onSelect}
              onToggle={onToggle}
              onCreateChild={onCreateChild}
              onRename={onRename}
              onDelete={onDelete}
              onSetAlias={onSetAlias}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

// ============================================================
// Small helpers
// ============================================================

function WikiStatusBadge({ status }: { status: WikiRecord['buildStatus'] }) {
  if (status === 'succeeded') {
    return <Badge variant="secondary" className="bg-green-100 text-green-700">已构建</Badge>
  }
  if (status === 'running') {
    return <Badge variant="secondary" className="bg-blue-100 text-blue-700">构建中</Badge>
  }
  if (status === 'failed') {
    return <Badge variant="destructive">构建失败</Badge>
  }
  return <Badge variant="outline">待构建</Badge>
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
