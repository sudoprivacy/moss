# 文档中心 v2 — 多数据源 + 知识树通用化(再设计)

> 状态:Draft for execution · 2026-05-14 · Owner: 武鹏
>
> 取代:上一版 P0(`feat/document-center` 分支,已 PR #9 等审)的"管理员手动上传 + 手建树"单一模型
>
> 输入:
> - 领导 v1 设计稿《LLM Wiki — Design Doc v1》(2026-05-12,主张 CAS / symlink / 自动 sync)
> - 锐锢客户 Q1-Q11 完整答卷(2026-05-14)→ 业务文档全在企微微盘 + 必须自动同步
> - 另一 B 端客户(2026-05-14)→ 数据源分散 + 需要手建树
> - 已实现的 P0 基础:`feat/document-center` 分支,DB / DocumentStore / WikiJobExecutor / AdminHub UI / wiki CLI 全套就绪

---

## 1. Context — 为什么要做 v2

P0 实现完成后,两个客户场景同时暴露,**单一产品模型对不上**:

| 客户类型 | 知识来源 | 树管理方式 | P0 支持吗 |
|---|---|---|---|
| **数据源集中型**(锐锢) | 单一外部源(企微微盘) | 树**自动从源镜像**,不手编 | ❌ 我们只支持手动上传 |
| **数据源分散型**(另一客户) | 多个来源 / 个人电脑 | 树**完全手建** | ✅ P0 正好对得上 |

进一步,即使锐锢答卷里 Q5 明确**业务方仍在企微微盘改文档**(因为这是给店铺/运营/客服多方同步的源),意味着 Web 上传模型(用户改完再上传)在锐锢不成立。

→ **新产品空间**:**多 connector 抽象 + 统一在 AdminHub 编排成知识树**,既覆盖锐锢的自动同步,也保留另一客户的手建。同时回应领导 v1 设计稿的核心主张(数据源 / 内容寻址 / 自动同步),但落地形态适配 B 端 SaaS。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│  数据源层(connector 抽象,可插拔)                                │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐   │
│  │ WecomDrive      │ │ Filesystem      │ │ (future: Feishu,│   │
│  │ Connector       │ │ Connector       │ │  SharePoint,    │   │
│  │ (P0,锐锢)      │ │ (P0,服务器FS)  │ │  钉钉网盘 ...)  │   │
│  └────────┬────────┘ └────────┬────────┘ └─────────────────┘   │
│           │                   │                                  │
│  统一接口 ExternalSourceConnector:                              │
│    init / list / walkTree / download / getEtag / testConnection │
│    watchChanges (optional, Phase 2)                              │
└───────────┼───────────────────┼──────────────────────────────────┘
            │                   │
            ▼                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  SourceSyncWorker(通用同步引擎)                                  │
│  - per source 按配置频率 poll(默认 1h)                          │
│  - 对每个文件:diff etag → 下载 → 入库 documents 表 + sha256     │
│  - 对每个文件夹:diff → 创建/重命名/移动/软删 document_tree_nodes │
│  - 内容变化的文档 → 标记关联 wikis.needs_rebuild = 1             │
│  - 软删 30 天后真正清理(独立 daily cleanup cron)                │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Document Store(P0 基础上扩展)                                   │
│  - document_tree_nodes:加 source_id / source_path / auto_managed/│
│    alias / last_synced_at / deleted_at                            │
│  - documents:加 source_id / external_id / external_etag /        │
│    content_sha256 / deleted_at                                    │
│  - wikis:加 needs_rebuild                                         │
│  - 新表:external_sources(凭据 + 配置)                            │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  AdminHub UI                                                      │
│  - 新页:"外部数据源"(列表 + 配置 + 测试连接 + 同步状态)         │
│  - 改造文档中心:                                                  │
│      * auto_managed 节点视觉锁定(灰色 / 加锁图标 / 显示 alias)  │
│      * Wiki 列表显示 "源已更新,建议重建" 角标                    │
│      * 同一棵树允许 auto_managed 和手建节点并存                   │
│  - 助手编辑:Wiki 关联不变(P0 已实现)                           │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. 三种产品使用模式

| 模式 | 谁用 | 行为 | 客户示例 |
|---|---|---|---|
| **A. 全手建** | 数据分散型客户 | 管理员手拖树、手上传文档、手新建 Wiki、手 Build | 下午沟通的另一 B 端 |
| **B. 全自动同步** | 数据集中型客户 | 配数据源 → 树自动镜像 → 文档自动入库 → 内容变化标 needs_rebuild → Build 由管理员决策(默认手动) | 锐锢(企微微盘) |
| **C. 混合** | 大部分客户 | 一棵树里两类节点并存:锁定的"同步节点"+ 自由的"手建节点" | 标准化文档 + 杂项内部文档 |

**锐锢具体配置**:模式 B,源=企微微盘根目录,挂载到树根,自动镜像树 + 手动 build,1h poll,软删 30 天。

---

## 4. 已拍板的 8 项产品决策

| # | 议题 | 决策 |
|---|---|---|
| 1 | 一棵树是否允许"自动镜像节点 + 手建节点"混合? | ✅ **允许** |
| 2 | 自动镜像节点是否能改名? | ❌ **不能改原名**,允许设置 alias 显示别名 |
| 3 | 外部源里的文件夹深度? | **全镜像**,深度 > 5 给 UI 警告(不阻塞) |
| 4 | 一个 wiki 是否能源混合(自动文档 + 手动上传文档)? | ✅ **可以**,wiki.source_document_ids 不区分来源 |
| 5 | 数据源凭据怎么存? | **沿用 system.* secret 模式**(AES 加密入 db) |
| 6 | webhook 实时同步? | **Phase 2**,P0 用 1h poll 完全够 |
| 7 | P0 内做几个 connector? | **2 个:企微微盘 + 本地 FS(挂载目录)** |
| 8 | "自动 build"是否默认开启? | ❌ **默认关闭**,管理员显式开启(避免烧 token) |

---

## 5. Connector 抽象接口

```typescript
// moss/src/server/sources/types.ts(新建)

export interface ExternalSourceConnector {
  type: 'wecom_drive' | 'filesystem' | string

  /** 用配置好的凭据建一个连接,失败抛错 */
  init(config: ExternalSourceConfig): Promise<void>

  /** 列出指定路径下的文件与子文件夹(单层,非递归)*/
  list(path: string): Promise<ExternalFileNode[]>

  /** 列整棵子树(用于全量初始同步)*/
  walkTree(rootPath: string): AsyncIterable<ExternalFileNode>

  /** 下载文件内容 */
  download(fileId: string): Promise<Buffer>

  /** 拿文件的 etag/lastModified,用于变更检测 */
  getEtag(fileId: string): Promise<string>

  /** 可选:订阅变更事件(P0 不实现,Phase 2 webhook 用)*/
  watchChanges?(callback: (event: ChangeEvent) => void): () => void

  /** 测试连接(配置页"测试"按钮调)*/
  testConnection(): Promise<{ ok: boolean; message?: string }>
}

export interface ExternalFileNode {
  externalId: string          // 源里的稳定 ID(企微 fileid / FS 相对路径)
  parentExternalId: string | null
  type: 'folder' | 'file'
  name: string
  size?: number
  mimeType?: string
  etag: string
  lastModified?: number
}
```

→ **核心同步逻辑只写一次**,每加一种 connector 就是几百行新代码。

---

## 6. DB schema 改动

### 新表 `external_sources`

```sql
CREATE TABLE IF NOT EXISTS external_sources (
  id                       TEXT PRIMARY KEY,
  org_id                   TEXT NOT NULL,
  type                     TEXT NOT NULL,        -- 'wecom_drive' | 'filesystem'
  name                     TEXT NOT NULL,
  config_json              TEXT NOT NULL,        -- {rootPath, mountedNodeId, ...}
  credentials_secret_key   TEXT,                  -- 引用 system.* secret 表
  sync_interval_sec        INTEGER NOT NULL DEFAULT 3600,
  auto_build_enabled       INTEGER NOT NULL DEFAULT 0,
  enabled                  INTEGER NOT NULL DEFAULT 1,
  last_sync_at             INTEGER,
  last_sync_status         TEXT,                  -- 'success' | 'failed' | 'running'
  last_sync_error          TEXT,
  created_by               TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX external_sources_org_idx ON external_sources (org_id);
```

### document_tree_nodes 加字段(增量迁移)

```sql
ALTER TABLE document_tree_nodes ADD COLUMN source_id TEXT;
ALTER TABLE document_tree_nodes ADD COLUMN source_path TEXT;
ALTER TABLE document_tree_nodes ADD COLUMN auto_managed INTEGER DEFAULT 0;
ALTER TABLE document_tree_nodes ADD COLUMN alias TEXT;
ALTER TABLE document_tree_nodes ADD COLUMN last_synced_at INTEGER;
ALTER TABLE document_tree_nodes ADD COLUMN deleted_at INTEGER;
CREATE INDEX document_tree_nodes_source_idx
  ON document_tree_nodes (source_id, source_path);
```

### documents 加字段(增量迁移)

```sql
ALTER TABLE documents ADD COLUMN source_id TEXT;
ALTER TABLE documents ADD COLUMN external_id TEXT;
ALTER TABLE documents ADD COLUMN external_etag TEXT;
ALTER TABLE documents ADD COLUMN content_sha256 TEXT;
ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
CREATE INDEX documents_sha_idx ON documents (org_id, content_sha256);
CREATE INDEX documents_external_idx
  ON documents (source_id, external_id);
```

### wikis 加字段(增量迁移)

```sql
ALTER TABLE wikis ADD COLUMN needs_rebuild INTEGER DEFAULT 0;
```

> 沿用现有 `try/catch ALTER TABLE` 增量迁移模式,与 moss 项目惯例一致。

---

## 7. SourceSyncWorker 同步算法

```
每次 tick(默认 1 小时一次,per source):

1. 读 external_sources 表,跳过 disabled 的
2. 对每个 enabled source:
   a. 初始化 connector(读凭据)
   b. for node in connector.walkTree(rootPath):
       - 是文件夹:
         - 在 document_tree_nodes 里按 (source_id, source_path) 查
         - 没找到 → 创建,auto_managed=true,挂在父节点下
         - 找到但 deleted_at 不空 → 恢复(undelete)
         - 找到且 source_path 变了 → update(rename / move)
       - 是文件:
         - 在 documents 里按 (source_id, external_id) 查
         - 没找到 → 下载 + 算 sha256 + 创建,挂父节点下
         - 找到且 etag 变了 → 下载 + 算 sha256 + 更新
            * sha256 变了 → 找所有引用此 doc.id 的 wiki,标 needs_rebuild=true
         - 找到且 etag 没变 → skip
   c. 反向扫:
       - documents 里 source_id=此 source 但本次未出现的 → 软删(deleted_at=now)
       - document_tree_nodes 同理
   d. 写 last_sync_at + status

3. 若 source.auto_build_enabled=true 且有 wiki.needs_rebuild=true:
   - 入队 build job(走现有 WikiJobExecutor)

4. 独立 daily cron:清理 deleted_at < now - 30d 的文档/节点
```

---

## 8. 完整改造清单与工时(P0)

| # | 改造 | 工时 | 依赖 |
|---|---|---|---|
| 1 | DB schema 改动(外部源表 + 现有表加字段) | 0.5 pd | - |
| 2 | Connector 抽象接口 + 注册机制 | 1 pd | 1 |
| 3 | WecomDrive Connector | 2 pd | 2 |
| 4 | Filesystem Connector(验证抽象 + 锐锢以外客户场景) | 1 pd | 2 |
| 5 | SourceSyncWorker(通用同步引擎) | 2 pd | 2 |
| 6 | 凭据存储(沿用 system.* secret 模式) | 0.5 pd | 1 |
| 7 | AdminHub "外部数据源"配置页(列表/新建/测试/启停) | 1.5 pd | 1, 2 |
| 8 | AdminHub 文档中心改造:auto_managed 节点锁定 + alias 显示 + needs_rebuild 角标 | 1 pd | 1 |
| 9 | Soft-delete + 30 天清理 cron | 0.5 pd | 1 |
| 10 | content-hash dedup(documents 按 sha256 复用 storage_path) | 2 pd | 1 |
| 11 | wiki-builder 输出 frontmatter + 自动写 `_moss_meta.json` | 1.5 pd | - |
| 12 | wiki.needs_rebuild 标记机制(同步层联动) | 0.5 pd | 1, 5 |
| 13 | 文档解析增强(mammoth for docx + libreoffice for pdf) | 1 pd | - |
| 14 | 端到端测试(锐锢真实文档 + FS connector 跑通) | 1 pd | - |
| **合计** | | **~15.5 pd** | |

---

## 9. 实施顺序(3 阶段)

### 阶段 1(~5 pd):基础设施

Item 1, 2, 4(用 FS connector 先打通,因它最简单)、5、6、9

**里程碑**:本地放几个 docx 到挂载目录 → SudoWork 自动同步入库 → 树节点自动创建 → wiki 可以基于这些文档手动建。

### 阶段 2(~5 pd):企微微盘 + AdminHub UI

Item 3、7、8

**里程碑**:锐锢测试环境的企微微盘接通 → 同步出真实文档 → AdminHub 显示自动节点锁定。

### 阶段 3(~5 pd):dedup + 质量提升 + 联调

Item 10、11、12、13、14

**里程碑**:同一份文档放微盘多处不重复 build / wiki chunk 有 frontmatter / 内容更新看到 needs_rebuild 角标 / 端到端跑通锐锢真实场景。

---

## 10. 给客户的话术更新

### 给锐锢

> "我们文档中心 v2 支持**多数据源接入**。锐锢这次配置:
> - 数据源 = 企微微盘
> - 同步频率 1 小时(您每周更新一次足够)
> - 删除文档保留 30 天可恢复
> - 自动构建默认关闭,您看着新文档来了再决定何时 build
>
> 未来如果接入其他数据源(SharePoint / 飞书云文档 / 服务器共享盘),只需要配置一下,**架构无需重做**。"

### 给下午聊的另一 B 端客户

> "您数据分散,我们文档中心 v2 完全支持手建模式 —— 您在 AdminHub 拖树、上传文档、自定义层级,需要时再新建 Wiki。
>
> 同时,如果未来某些文档统一存到了某个数据源(网盘 / 共享盘 / SharePoint),可以配置 connector 让那部分树**自动同步**,跟手建的部分并存,不互相干扰。
>
> 这给了您'**渐进式标准化**'的空间 —— 先用手建,慢慢推动业务统一到某个源,再切自动同步,不强求一步到位。"

### 给领导(对 v1 设计稿的回应)

> "您 v1 的核心思想(数据源 + 内容寻址 + 自动同步)我们吸收了,落地为可插拔的 connector 抽象。但和您原稿不同:
>
> 1. 我们不用 symlink+filesystem 直挂模型,而是让 connector 把外部源**镜像进 DB 树**,因为 B 端客户多数走 Web 上传(SaaS 部署 / 不愿给文件系统访问)
> 2. Wiki 主键仍用 UUID(保 Assistant.enabledWikis 引用稳定),用 content_sha256 索引做 dedup
> 3. P0 实现 2 个 connector:企微微盘(锐锢)+ 本地 FS(贴近您 v1 的"客户给目录路径"场景)
> 4. 同时支持模式 A(全手建)/ B(全自动)/ C(混合),覆盖更多客户形态"

---

## 11. 锐锢侧立刻要做的事

应用名称:**SudoWork 智引助手**
应用 Logo:从 sudowork repo `resources/sudowork-banner-1.png` 切 512×512 PNG(可由我们出图)
权限:微盘读取(列文件 / 下载文件 / 监听变更)
可见范围:全员

锐锢侧建好后,提供:
- CorpID
- AgentID
- AgentSecret

这三个在 AdminHub → 外部数据源 → 新建企微微盘源 → 测试连接 → 启用,即可开始同步。

---

## 12. 关键文件参考(实施时)

| 模块 | 文件 |
|---|---|
| DB | `moss/src/server/db.ts`(加字段 + 新表)|
| 类型 | `moss/src/server/sources/types.ts`(新建,connector 接口)|
| WeCom Connector | `moss/src/server/sources/wecomDrive.ts`(新建) |
| FS Connector | `moss/src/server/sources/filesystem.ts`(新建) |
| Sync Worker | `moss/src/server/sources/syncWorker.ts`(新建)|
| Document Store | `moss/src/server/documentStore.ts`(扩展 deletedAt/sha256 处理)|
| Wiki Builder | `moss/src/channels/gateway/WikiJobExecutor.ts`(改造 wiki-builder 写 frontmatter + meta.json)|
| 文档解析 | `moss/src/server/sources/docParsers.ts`(新建,mammoth + libreoffice 封装)|
| AdminHub UI | `moss/admin/src/pages/external-sources-page.tsx`(新建)、`document-center-page.tsx`(改 auto_managed UI)|
| API Client | `moss/admin/lib/api/external-sources.ts`(新建) |
| Server 路由 | `moss/src/server/server.ts`(新加 `/api/v1/external-sources/*` 路由)|

---

## 13. 验证清单

每个改造跑通后:

- **Item 4 FS Connector**:把 `/tmp/test-docs/` 配为数据源 → 放 3 份 docx → 跑同步 → 看 documents 表 + 树节点出现
- **Item 5 SyncWorker**:改一份 docx 内容 → 等 1h 或手动触发 → sha256 变了 → wikis 表对应 wiki.needs_rebuild=1
- **Item 8 UI**:auto_managed 节点显示锁图标,试图改名应被拒
- **Item 10 dedup**:同份 docx 出现在树两个位置 → documents 只存一份(同 sha256 复用 storage_path)
- **Item 11 meta.json**:build 完一个 wiki → 看 `$MOSS_HOME/wikis/<id>/_moss_meta.json` 是否存在 + pages[] 含 type/title
- **Item 14 端到端(锐锢)**:跑通"企微微盘改文档 → 1h 后 SudoWork 同步 → Wiki 标 needs_rebuild → 管理员 build → Agent 答题用上新内容"全流程
