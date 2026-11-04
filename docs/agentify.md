# 协作智能体（agentify）

让一个智能体成为长期存在的“岗位数字分身”：它的会话、产出和记忆属于智能体本身，跨会话、跨员工沉淀；智能体之间可以查询、委派任务，并由对方把它愿意共享的文件交过来（不能直接读取对方的数据）。岗位不在 moss 中建模——谁能用某个智能体，仍由它的可见范围决定。

## 开启

管理端 → 协作智能体 → 选择智能体 → 配置 → 开启协作。配置对话框分四页：「常规」（历史时间、记忆注入字数）、「对外能力」（能力、可调用的智能体、任务确认人、每日上限）、「共享权限」（每类数据的范围与名单）、「JSON」（同一份配置）。前三页可完成全部设置，不需要手写 JSON。对应的 JSON 示例：

```json
{
  "sharing": {
    "users":   { "allow": ["*"], "deny": ["<员工 ID>"] },
    "summary": "agents",
    "output":  { "level": "agents", "agents": { "allow": ["gendan"], "deny": [] } },
    "input":   { "level": "users", "users": ["<员工 ID>", "<员工 ID>"] }
  },
  "memory": { "injectChars": 4000 },
  "a2a": {
    "capabilities": [
      { "id": "return-stats", "kind": "ask", "description": "查询返厂统计、原因和结论" },
      { "id": "return-report", "kind": "task", "description": "生成返厂分析报表文件" },
      { "id": "notify-supplier", "kind": "task", "description": "通知供应商处理返厂",
        "requiresConfirmation": true, "allowOutbound": true }
    ],
    "callers": { "allow": ["gendan", "catem"], "deny": [] },
    "confirmers": ["<员工 ID>"],
    "dailyCallLimit": 200
  }
}
```

| 字段 | 含义 |
|---|---|
| `sharing` | 每类数据的共享范围与名单，见下方「共享权限」 |
| `memory.injectChars` | 新会话开头注入的记忆字数上限 |
| `memory.digestLookbackHours` | 整理回溯（小时）：最近活动在此时间内的会话会被整理、建索引（有变化时重新整理）。更早的会话不再处理，但已整理的内容保留。不填 = 服务器默认 |
| `memory.decayHalfLifeHours` | 检索时间衰减半衰期（小时）：按最近活动时间计算，每过一个半衰期，时间权重向 0.7 下降一半（相关性仍是主导）。`0` = 不衰减。不填 = 服务器默认 |
| `memory.deleteAfterHours` | 历史删除期限（小时）：最近活动早于此时间的摘要、对话、产出副本、协作记录及其索引会被删除（每小时检查一次）。`0` = 永久保留。记忆条目（`memory/`）不按时间删除。不填 = 服务器默认 |
| `capabilities` | 本智能体对外提供的能力。`ask` 只读问答；`task` 委派任务。`allowOutbound`（可对外发送）必须同时 `requiresConfirmation` |
| `capabilities[].callers` | 能力级名单 `{allow, deny}`：替代 `a2a.callers`，例如「B 只能问，C 才能委派」 |
| `requireCallerVisibility` | 能力级开关：发起调用的员工也必须能直接使用本智能体 |
| `capabilities[].runAsUserId` | 能力级执行身份：回答时使用哪位员工的凭据（个人凭据、所在部门的凭据）访问后台系统。不填 = 发起调用的员工本人。由管理员在「对外能力」页从所有用户中选择；保存时校验该用户存在且有效。见下方「执行身份」 |
| `callers` | 允许调用本智能体的智能体 `{allow, deny}`（名称、显示名或 ID；`*` = 所有已开启协作的智能体；排除优先）。也可写成数组（只有 allow） |
| `confirmers` | 可以确认委派任务的员工；管理员始终可以。确认人不需要管理员权限：登录管理端后在左侧「待确认任务」中处理（只显示自己可以确认的任务） |
| `dailyCallLimit` | 每天最多接受的调用次数 |

三个时间字段在配置对话框的「常规」页填写。整理回溯不会超过删除期限（否则会反复整理又删除）：同时填写时校验，使用默认值时自动取较小者。

服务器默认值（环境变量，单位：小时）：

| 变量 | 默认 |
|---|---|
| `MOSS_AGENTIFY_DIGEST_LOOKBACK_HR` | `720`（30 天） |
| `MOSS_AGENTIFY_DECAY_HALF_LIFE_HR` | `720`（30 天；`0` = 不衰减） |
| `MOSS_AGENTIFY_DELETE_AFTER_HR` | `4320`（180 天；`0` = 永久保留） |

删除只涉及主目录中的整理结果和索引；主机上的原始会话记录（会话列表中的会话）不受影响。需要立即执行时：`POST /api/v1/admin/agentify/agents/<智能体>/purge`。

配置存在 `agentify_agents` 表（按智能体稳定 ID），不写入 `_moss_meta.json`。

旧配置照常读取：`allowCallers` → `callers.allow`；`memory.share: full` → 对话正文和输入文件为「本智能体员工」；`historyReaders` 中的智能体 → 摘要和产出为「员工 + 其他智能体」，名单即原来的读取者（它们改为通过交接获得，不再直接读取）。

### 共享权限

智能体主目录里的一切都属于这个智能体。每类数据设一个共享范围：

| 范围 | 谁能看到 |
|---|---|
| `private`（仅本人） | 产生它的员工（会话发起人） |
| `users`（本智能体员工） | 另加员工名单中的、能使用本智能体的员工 |
| `agents`（员工 + 其他智能体） | 另加智能体名单中的智能体，**只能通过交接**：对方提问，本智能体回答时能看到并交出这些数据；对方不能直接检索或读取 |

管理员始终能看到全部。范围逐级包含。

| 数据类型 | 内容 | 默认 |
|---|---|---|
| `conversation` | 对话正文 | `private` |
| `summary` | 会话摘要；与其他智能体的协作记录 | `users` |
| `input` | 员工提供的输入文件及其内容 | `private` |
| `output` | 产出文件、内容及每次会话的文件清单 | `users` |
| `intermediate` | `.drafts/` 中间文件 | `private` |
| `sharedMemory` | 共享记忆（不能设为 `private`） | `users` |
| （个人记忆） | 某员工的个人记忆 | 始终仅本人，不可配置 |

名单（`{ "allow": [...], "deny": [...] }`，也可只写数组 = allow；排除优先；`*` = 全部）：

- `sharing.users`：默认员工名单（员工 ID 或名称），默认 `["*"]`。
- `sharing.agents`：默认智能体名单；不填 = 与 `a2a.callers` 相同。
- 每个类型可写自己的 `users` / `agents`，覆盖默认名单。简写：`"summary": "agents"`。

管理端配置对话框的「共享权限」页与 JSON 同步，可直接选择范围和名单。某类数据未单独设名单时使用默认名单；在该类数据上改名单（例如排除一名员工）会从默认名单开始修改。智能体列表的「可交给其他智能体」列显示每个智能体对其他智能体开放的数据类型。

摘要不会比它的来源更开放：输入文件比摘要更私密时，摘要只写输入文件名，不写其内容；摘要模型被要求不写身份证号、手机号、银行卡号、密码、密钥等。

## 智能体在会话里怎么用

开启协作的智能体，首条消息会带上 `[Agent Home & Collaboration]` 区块：它记住的内容、最近的工作、可协作的同事智能体及其能力。容器内用 `agentctl`：

```
agentctl recall "<问题或关键词>"                 # 检索自己的历史（摘要、产出、记忆、协作记录）
agentctl history list | show <id>
agentctl memory add "<事实>" [--private]
agentctl files get <path>

agentctl agents
agentctl ask --agent <名称> --capability <id> "<问题>"       # 等待回答；交回的文件存到 ./from-<对方>/
agentctl delegate --agent <名称> --capability <id> "<任务>" [--wait]
agentctl call <callId> [--wait] [--save] | cancel <callId>

agentctl handoff <路径或文件名>                  # 回答其他智能体时：把已保存的文件交给对方
```

交接：回答其他智能体的会话里，`recall`、`history`、`files get` 只返回共享给对方的数据（范围 `agents` 且对方在名单中），不注入员工的个人记忆和最近工作；`handoff` 只能交出这些数据。本次会话新生成的文件自动交出。对方用 `agentctl call <id> --save` 取回（`ask` 默认自动保存）。交出的副本存在 `handoffs/<call>/`，随协作记录一起按删除期限清理。

## 规则（全部在服务端校验）

- 调用方身份来自会话令牌（智能体 + 会话），请求内容不能扩大权限。
- 被问的智能体在全新的会话里回答，**只读**：企业应用的发送、上传、建群、群发队列等接口一律拒绝；通过已存凭据访问后台系统（`fetchurl`、凭据代理）时只允许 GET / HEAD / OPTIONS，POST / PUT / PATCH / DELETE 返回 403 `readonly_session`，不会到达后台系统。只有经人工确认、且能力声明了 `allowOutbound` 的任务才能对外动作。
- 调用最多嵌套 2 层；调用链中出现过的智能体不能再被调用（防循环）；每日次数上限。
- 其他智能体不能直接检索或读取本智能体的主目录（`recall --agent`、`files get --agent` 一律拒绝）。它只能提问或委派，拿到本智能体的回答和交出的文件。
- 回答其他智能体时，会话按“对方智能体”的身份看数据：只有共享范围为 `agents` 且对方在名单中的数据；任何员工的私有数据（即使发起调用的员工本人拥有）都不可见，因为回答会进入对方的历史。
- 只有发起调用的智能体能取回该次调用交出的文件。
- 每次调用都记录在 `a2a_calls`，并写入双方的智能体主目录、可被检索。

### 执行身份（runAsUserId）

回答其他智能体时，会话默认以**发起调用的员工**身份运行：用的是他本人的个人凭据和他所在部门的凭据。如果发起方员工没有某个后台系统的账号，本智能体也就访问不到。

能力可以指定一名**执行身份员工**（例如负责 TMS 的同事或专门的服务账号）：

- 回答会话以该员工身份运行，使用其个人凭据和部门凭据；企业级凭据不受影响。
- 发起方由此获得本智能体在该员工权限下能查到的信息，即使发起方本人没有该系统的权限。这是管理员明确授予的委托，只对这一个能力生效。
- 本智能体看到的已存数据不变：仍只能看到共享给发起方智能体的数据，不注入任何员工的个人记忆。
- 回答仍为只读（见上），只能读取后台数据；经人工确认的对外任务除外。待确认任务页会提示该任务将以谁的凭据执行。
- 调用记录同时记下发起员工和执行身份；摘要来源写作「背后员工 X，以员工 Y 的凭据执行」。调用消耗的模型用量计入执行身份员工的会话。
- 自定义智能体若限制了可见范围，执行身份员工需在其范围内，否则调用失败并说明原因。

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
/agent-home/<org>/<agent>/handoffs/<call>/<文件>                         交给调用方的已保存文件副本
```

moss.db 中只有索引：`agentify_docs`、`agentify_chunks`（含向量）、`agentify_chunks_fts`（FTS5 trigram，中文无需分词器）。检索 = 关键词 + 向量（复用知识库的 multilingual-e5-small）RRF 融合 + 时间衰减。原始会话记录仍在主机磁盘，不进主目录。

会话结束、或安静 2 分钟后（`MOSS_AGENTIFY_DIGEST_QUIET_MS`），后台每分钟整理一次：生成摘要（系统模型；不可用时用抽取式摘要）、复制产出文件、建索引。

### 定时任务

- **按每次运行整理。** 定时任务（尤其“复用会话”模式，一个会话最多承载 50 次运行）的会话按运行记录（`cron_job_runs`）切分，每次运行单独生成摘要、对话、文件清单和文件内容索引，目录为 `history/<yyyy>/<mm>/<会话>@<运行开始时间>-<编号>/`，产出与输入副本同样按运行分开。已整理过的运行不再重复整理，每次新运行只多一次摘要模型调用。
- **标明来源。** 每次运行的摘要标题为「定时任务「<任务名>」<开始时间>」，所有检索结果（摘要、文件内容、文件清单）都带来源，`agentctl recall` 显示为 `from: 定时任务「类目经营日报」2026-11-04 10:30 的运行（员工 张三名下）`；员工发起的会话显示 `员工 张三发起的对话`，其他智能体的请求显示协作来源。时间按任务的时区（未设置时为 `MOSS_CRON_DEFAULT_TZ`，默认 Asia/Shanghai）。
- **运行提示。** 开启协作的智能体，每次定时运行的消息前加一行 `【定时任务「<任务名>」本轮运行，开始于 2026-11-04 10:30】`，与历史中的名称一致。未开启协作的智能体，定时任务消息不变。
- 运行归属执行它的员工（定时触发为任务执行人，手动触发为点击的人）。删除期限按每次运行各自的最后活动时间计算，旧运行删除不影响同一会话中较新的运行。

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

可见范围按「共享权限」：

- 产出（`output`）：默认所有使用该智能体的员工可检索和读取；设为 `agents` 后可交给名单中的智能体。
- 输入（`input`）：默认只有提供它的员工（以及管理员）可见；可按名单开放给员工或智能体。
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
