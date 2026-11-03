# 协作智能体（agentify）

让一个智能体成为长期存在的“岗位数字分身”：它的会话、产出和记忆属于智能体本身，跨会话、跨员工沉淀；智能体之间可以查询、委派任务、读取对方已完成的工作。岗位不在 moss 中建模——谁能用某个智能体，仍由它的可见范围决定。

## 开启

管理端 → 协作智能体 → 选择智能体 → 配置 → 开启协作。配置（JSON）示例：

```json
{
  "memory": { "share": "summary", "injectChars": 4000 },
  "a2a": {
    "capabilities": [
      { "id": "return-stats", "kind": "ask", "description": "查询返厂统计、原因和结论" },
      { "id": "return-report", "kind": "task", "description": "生成返厂分析报表文件" },
      { "id": "notify-supplier", "kind": "task", "description": "通知供应商处理返厂",
        "requiresConfirmation": true, "allowOutbound": true }
    ],
    "allowCallers": ["gendan"],
    "historyReaders": ["gendan"],
    "confirmers": ["<员工 ID>"],
    "dailyCallLimit": 200
  }
}
```

| 字段 | 含义 |
|---|---|
| `memory.share` | `summary`：其他员工的会话只共享摘要、结论和产出；`full`：也共享对话正文。员工本人始终能看到自己的。个人记忆永不共享 |
| `memory.injectChars` | 新会话开头注入的记忆字数上限 |
| `memory.digestLookbackHours` | 整理回溯（小时）：最近活动在此时间内的会话会被整理、建索引（有变化时重新整理）。更早的会话不再处理，但已整理的内容保留。不填 = 服务器默认 |
| `memory.decayHalfLifeHours` | 检索时间衰减半衰期（小时）：按最近活动时间计算，每过一个半衰期，时间权重向 0.7 下降一半（相关性仍是主导）。`0` = 不衰减。不填 = 服务器默认 |
| `memory.deleteAfterHours` | 历史删除期限（小时）：最近活动早于此时间的摘要、对话、产出副本、协作记录及其索引会被删除（每小时检查一次）。`0` = 永久保留。记忆条目（`memory/`）不按时间删除。不填 = 服务器默认 |
| `capabilities` | 本智能体对外提供的能力。`ask` 只读问答；`task` 委派任务。`allowOutbound`（可对外发送）必须同时 `requiresConfirmation` |
| `requireCallerVisibility` | 能力级开关：发起调用的员工也必须能直接使用本智能体 |
| `allowCallers` | 允许调用本智能体的智能体（名称、显示名或 ID；`*` = 所有已开启协作的智能体） |
| `historyReaders` | 允许直接检索本智能体共享历史、读取其产出文件的智能体 |
| `confirmers` | 可以确认委派任务的员工；管理员始终可以 |
| `dailyCallLimit` | 每天最多接受的调用次数 |

三个时间字段也可在管理端配置对话框上方直接填写。整理回溯不会超过删除期限（否则会反复整理又删除）：同时填写时校验，使用默认值时自动取较小者。

服务器默认值（环境变量，单位：小时）：

| 变量 | 默认 |
|---|---|
| `MOSS_AGENTIFY_DIGEST_LOOKBACK_HR` | `720`（30 天） |
| `MOSS_AGENTIFY_DECAY_HALF_LIFE_HR` | `720`（30 天；`0` = 不衰减） |
| `MOSS_AGENTIFY_DELETE_AFTER_HR` | `4320`（180 天；`0` = 永久保留） |

删除只涉及主目录中的整理结果和索引；主机上的原始会话记录（会话列表中的会话）不受影响。需要立即执行时：`POST /api/v1/admin/agentify/agents/<智能体>/purge`。

配置存在 `agentify_agents` 表（按智能体稳定 ID），不写入 `_moss_meta.json`。

## 智能体在会话里怎么用

开启协作的智能体，首条消息会带上 `[Agent Home & Collaboration]` 区块：它记住的内容、最近的工作、可协作的同事智能体及其能力。容器内用 `agentctl`：

```
agentctl recall "<问题或关键词>"                 # 检索自己的历史（摘要、产出、记忆、协作记录）
agentctl history list | show <id>
agentctl memory add "<事实>" [--private]
agentctl files get <path>

agentctl agents
agentctl ask --agent <名称> --capability <id> "<问题>"
agentctl delegate --agent <名称> --capability <id> "<任务>" [--wait]
agentctl call <callId> | cancel <callId>
agentctl recall --agent <名称> "<关键词>"        # 对方共享的历史
agentctl files get --agent <名称> <path>         # 对方的产出文件
```

## 规则（全部在服务端校验）

- 调用方身份来自会话令牌（智能体 + 会话），请求内容不能扩大权限。
- 被问的智能体在全新的会话里回答，**只读**：企业应用的发送、上传、建群、群发队列等接口一律拒绝。只有经人工确认、且能力声明了 `allowOutbound` 的任务才能对外动作。
- 调用最多嵌套 2 层；调用链中出现过的智能体不能再被调用（防循环）；每日次数上限。
- 其他智能体只能读共享内容：摘要、产出、协作记录、共享记忆；不能读对话正文和个人记忆。
- 每次调用都记录在 `a2a_calls`，并写入双方的智能体主目录、可被检索。

## 数据放在哪里

智能体主目录（Nexus VFS；没有 Nexus 时为 `<rootDir>/agent-home`）：

```
/agent-home/<org>/<agent>/history/<yyyy>/<mm>/<session>/summary.md       摘要
                                                    .../conversation.md  对话（去掉工具载荷）
                                                    .../artifacts.json   产出清单
/agent-home/<org>/<agent>/artifacts/<session>/<文件>                     产出与中间文件副本
/agent-home/<org>/<agent>/inputs/<session>/<文件>                        输入文件副本（员工上传 / 指定的文件）
                                             <文件>.extract.json          可解析文件的结构化数据（JSON）
/agent-home/<org>/<agent>/memory/shared.md | users/<员工>.md              记忆
/agent-home/<org>/<agent>/a2a/<call>.md                                  协作记录
```

moss.db 中只有索引：`agentify_docs`、`agentify_chunks`（含向量）、`agentify_chunks_fts`（FTS5 trigram，中文无需分词器）。检索 = 关键词 + 向量（复用知识库的 multilingual-e5-small）RRF 融合 + 时间衰减。原始会话记录仍在主机磁盘，不进主目录。

会话结束、或安静 2 分钟后（`MOSS_AGENTIFY_DIGEST_QUIET_MS`），后台每分钟整理一次：生成摘要（系统模型；不可用时用抽取式摘要）、复制产出文件、建索引。定时任务复用同一会话时，会重新整理并替换。

### 文件内容检索（输入与产出）

整理会话时，除摘要和对话外，会话涉及的文件也逐个建立索引：

- **输入**：员工通过上传接口放进会话的文件、员工消息里点名的文件（通常是 `@文件名`）、或智能体开始工作前就在工作区里的文件。
- **产出 / 中间文件**：会话期间智能体新建或修改的文件（`.drafts/` 下为中间文件）。
- 内容相同的文件（重复上传）只保存、只索引一次；未变化的文件再次整理时不重新解析。

| 格式 | 怎么解析 |
|---|---|
| xlsx / xlsm、csv / tsv（UTF-8 或 GB18030） | 逐行：每行一条「列名=值」记录（如 `第12行：日期=2026-10-03｜出发地=上虞｜运费含税=694.2`），自动识别表头（跳过合并的标题行）；日期转为 ISO，公式取计算结果，合并单元格补齐。每个工作表另有概况：行数、列、类型、数值范围与合计、日期范围 |
| docx | 标题层级与段落；表格按行转为「列名=值」 |
| pptx | 每页文字与备注 |
| pdf | 每页文字（pdftotext） |
| xls / ods / doc / rtf / odt / ppt / odp | 先用 LibreOffice 转换，再按上面处理 |
| md / txt / json / yaml / html 等 | 原文 |

表格不转成 markdown 表：检索按约 500 字的片段召回，片段离开表头后数字就失去含义；每行带列名可以单独理解。每个文件的完整数据另存为 `<文件>.extract.json`（工作表为按列名的 JSON 行，类型保留），智能体用 `agentctl files get <路径>.extract.json` 即可读取，运行环境无需安装表格库。

可见范围与对话相同：

- 产出：所有使用该智能体的员工、以及有 `historyReaders` 权限的其他智能体都可检索和读取。
- 输入：只有提供它的员工（以及管理员）可见；`memory.share = full` 时对所有员工和有读取权限的智能体开放。
- 会话摘要和文件清单写明「输入文件 → 产出文件」，按任一文件命中都能找到同一会话。

限制（环境变量）：每个工作表索引前 `MOSS_AGENTIFY_EXTRACT_MAX_INDEX_ROWS`（3000）行、JSON 保留前 `MOSS_AGENTIFY_EXTRACT_MAX_JSON_ROWS`（50000）行（概况统计覆盖全部行）；每个文件最多 `MOSS_AGENTIFY_EXTRACT_MAX_EMBEDDED_CHUNKS`（40）个片段做向量，其余行只做关键词检索；每次整理最多解析 `MOSS_AGENTIFY_EXTRACT_MAX_FILES`（20）个文件；单个文件超过 `MOSS_AGENTIFY_ARTIFACT_MAX_FILE_BYTES`（20MB）只登记文件名。图片暂不识别文字。

升级后，回溯期内已整理过的会话会自动重新整理一次，补上文件内容。

## Nexus 升级（0.1.5 → 0.8.26）

新镜像带 nexusd 0.8.26 + 密钥库 0.5.71，并在 `bin/nexus/legacy` 保留 0.1.5 + 0.5.44。首次启动遇到旧数据时：

1. 复制整个 Nexus 数据目录到 `~/.moss/nexus/backups/`；
2. 用旧版启动一次，记录每条密钥的命名空间、键、版本、值哈希；
3. 用新版启动（首次打开时自动迁移），逐条比对；
4. 一致则写版本标记并继续；否则恢复备份、改用旧版运行，并在管理端显示“升级失败，已回退”。

结果写在 `~/.moss/nexus/upgrade-report.json`，管理端“协作智能体”页顶部可见。

- 暂缓升级：设置 `MOSS_NEXUS_UPGRADE=hold`，继续用旧版运行旧数据；去掉该变量并重启即升级。
- 手动回滚：停服务，把 `backups/` 里的目录换回 `data/`，用旧镜像启动。
- 演练：`npx tsx scripts/nexus-upgrade-rehearsal.ts --data <数据副本> --new <新版目录> --legacy <旧版目录>`。

## 测试

- 单元 / 集成：`node scripts/test-server.js`（`src/server/agentify/__tests__`、`src/server/nexus/__tests__/nexusUpgrade.test.ts`），`cd cli/agentctl && go test ./...`
- 端到端（真实模型，仅限测试环境）：`npx tsx scripts/agentify-e2e.ts --base http://127.0.0.1:43137 --db <该服务的 moss.db>`
