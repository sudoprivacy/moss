import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ListEmptyState,
  ListError,
  ListSkeleton,
  ListStatusBadge,
  ListSummary,
  ListSurface,
  ListToolbar,
} from '../components/list-page'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

const render = renderToStaticMarkup

test('toolbar retains labelled filters and independently accessible actions', () => {
  const html = render(
    <ListToolbar aria-label="用户筛选" actions={<button type="button">新建用户</button>}>
      <input aria-label="搜索用户" />
      <button type="button">全部角色</button>
    </ListToolbar>,
  )
  assert.match(html, /aria-label="用户筛选"/)
  assert.match(html, /aria-label="搜索用户"/)
  assert.ok(html.indexOf('全部角色') < html.indexOf('新建用户'))
  assert.match(html, /flex-wrap/)
})

test('surface preserves semantic table, overflow container, busy state and result footer', () => {
  const html = render(
    <ListSurface aria-label="用户列表" aria-busy={true} footer={<ListSummary>显示 2 / 5 个用户</ListSummary>}>
      <Table>
        <TableHeader><TableRow><TableHead>用户</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>测试用户</TableCell><TableCell><button>查看详情</button></TableCell></TableRow></TableBody>
      </Table>
    </ListSurface>,
  )
  assert.match(html, /^<section/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /data-slot="table-container"[^>]*overflow-x-auto/)
  assert.match(html, /<thead/)
  assert.match(html, /<tbody/)
  assert.match(html, /查看详情/)
  assert.ok(html.indexOf('显示 2 / 5 个用户') > html.indexOf('</table>'))
})

test('empty and no-result states carry distinct copy and optional recovery action', () => {
  const empty = render(<ListEmptyState title="暂无会话" description="创建会话后显示记录。" />)
  const filtered = render(<ListEmptyState title="没有匹配的会话" description="调整筛选条件。" action={<button>清除筛选</button>} />)
  assert.match(empty, /暂无会话/)
  assert.doesNotMatch(empty, /<button/)
  assert.match(filtered, /没有匹配的会话/)
  assert.match(filtered, /清除筛选/)
  assert.match(filtered, /aria-hidden="true"/)
})

test('load error is an alert with a labelled retry control, not an empty list', () => {
  const html = render(<ListError title="无法加载任务列表" description="刷新失败，保留上次数据。" onRetry={() => {}} />)
  assert.match(html, /role="alert"/)
  assert.match(html, /无法加载任务列表/)
  assert.match(html, /保留上次数据/)
  assert.match(html, /重新加载/)
  assert.doesNotMatch(html, /disabled=""/)
  assert.doesNotMatch(html, /data-slot="empty"/)
})

test('retrying disables the retry control and announces its action', () => {
  const html = render(<ListError title="读取失败" description="正在重试。" onRetry={() => {}} retrying />)
  assert.match(html, /<button[^>]*disabled=""/)
  assert.match(html, /正在重试/)
})

test('skeleton exposes one named busy status and hides decorative rows', () => {
  const html = render(<ListSkeleton label="正在加载用户列表" rows={3} />)
  assert.match(html, /role="status" aria-busy="true"/)
  assert.match(html, /正在加载用户列表/)
  assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 4)
  assert.match(html, /motion-reduce:animate-none/)
})

test('status badges retain text, use semantic tones and hide decorative dots', () => {
  for (const [tone, label, expectedClass] of [
    ['neutral', '创建中', 'bg-muted'],
    ['positive', '进行中', 'bg-primary/10'],
    ['danger', '失败', 'bg-destructive/10'],
  ] as const) {
    const html = render(<ListStatusBadge tone={tone}>{label}</ListStatusBadge>)
    assert.ok(html.includes(expectedClass))
    assert.ok(html.includes(label))
    assert.match(html, /aria-hidden="true"/)
  }
})

test('unknown status labels remain readable and escaped, without implying success', () => {
  const html = render(<ListStatusBadge>{'unknown <status>'}</ListStatusBadge>)
  assert.match(html, /unknown &lt;status&gt;/)
  assert.match(html, /bg-muted/)
  assert.doesNotMatch(html, /bg-primary\/10/)
})
