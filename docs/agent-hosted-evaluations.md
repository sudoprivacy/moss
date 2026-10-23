# 托管运行评测

Moss 管理页现在可以为已审核登记的内部托管 Dify/LangGraph 制品选择不可变评测集，启动并查看逐用例结果、运行节点和模型调用关联。这是迁移后的评测记录；登记、运行成功与评分本身都不会授予 L2 或发布版本。

## 操作与状态

组织管理员进入“智能体管理 → 智能体台账”，选择条目的“托管制品”。先登记预置镜像及评测集，再选择两者开始评测。所有样本都进入分母，包括失败、停止和未知结果。精确匹配只去除 ASCII 首尾空白；浏览器不能提交评分、执行身份、lease 或密钥。

页面定期只读刷新。负责人可以查看自己的记录；组织管理员可以启动、继续尚未开始的用例、停止或核对超时与凭证回收。每个新用例和模型调用都重新检查当前组织成员与管理权限。未确认的已开始用例永不自动重发。停止会关闭排队用例并撤销 IAM，无法据此断言远端容器已取消。

Nexus Registry 持久化评测及一次性 claim。Moss 调用正式 Nexus supervisor，在隔离容器内执行固定制品；模型经 Nexus 内容检查、实际 IAM 授权、Router 短期凭证和账单路径。评测记录不是新的通用 Task 权威。运行节点是 worker 上报，模型关联由执行服务记录；费用以 Router 核验结果为准。

未知调用可能已计费。核对操作只补查账单、回收凭证，不重发模型，也不把已知费用改写成成功结果。容器清理未确认会阻止同一评测继续；当前核对不能制造容器清理证明，需部署人员核对执行节点。

## 部署装配

设置绝对路径 `MOSS_AGENT_HOSTED_CONFIG_FILE`。未配置时管理台仍能登记和查看；运行入口明确拒绝。配置缺失或非法时服务启动失败，不回退到直连模型。配置示例中的路径和 ID 需换成现场已有授权资源：

```json
{
  "runner": {
    "python": "/opt/nexus/bin/python",
    "docker": "/usr/bin/docker"
  },
  "relays": [{
    "id": "office-relay", "port": 22161,
    "credentialFile": "/run/secrets/hosted-relay-token",
    "nexus": {
      "endpoint": "https://127.0.0.1:22160",
      "model_mounts": ["/cloud-model"],
      "tls": {"ca": "/run/tls/ca.pem", "cert": "/run/tls/node.pem", "key": "/run/tls/node-key.pem", "serverName": "nexus-node"}
    }
  }],
  "resources": [{
    "orgId": "organization-id", "id": "evaluation-model",
    "model": "approved-model", "endpoint": "http://127.0.0.1:22146/v1",
    "maxOutputTokens": 128, "allowedAddresses": ["127.0.0.1"],
    "relayId": "office-relay", "modelMount": "/cloud-model",
    "router": {"baseUrl": "http://127.0.0.1:22146", "accountId": 1, "consoleTokenFile": "/run/secrets/router-console", "quotaPerCall": 25000, "group": "default"}
  }]
}
```

- Nexus 必须预置对应内容闸、模型挂载及同实例 relay 上游；relay 仅监听 loopback，不保存 Router 模型密钥到 VFS 请求。
- Registry zone 和实际 IAM 必须已配置 evaluator/gateway 服务主体；采用既有 Registry 显式 schema 初始化流程，先备份，常规启动不自动迁移 owner 数据。
- 所有引用的凭证和 TLS 私钥必须是仅所有者可读的文件。容器不收到 IAM/Router 密钥；不得提供宿主机目录、网络、设备或额外 capabilities。
- 预置已审镜像、Python 依赖及 supervisor。运行禁止拉取镜像。`modulePath` 仅供受控源码部署指定 Nexus 模块路径，不能由任务或浏览器设置。
- 多实例必须各有独立 loopback relay 与明确的 Nexus 上游关联。本轮只验证单实例；不能据此宣称 PostgreSQL/HA 已验收。

## 本轮验证与边界

2026-10-21 真实 CUA 管理页启动固定 Dify 制品，两个算术样本返回 42、13，2/2 通过；容器正常退出清理、IAM 回收及两笔真实 Router 账单核对通过。之前的三笔结果未知调用也核对到了账单，保持未知且未重发。

实测发现飞书 SDK 会将共享 Protobuf Long 支持设为 undefined，导致打包服务收到数字型空游标。已在模型响应边界接受精确的非负安全整数，规范化为字符串，并拒绝不安全整数、非法或越界 uint64 值；验证包含多次空轮询只写入一次请求。临时诊断日志未进入源码或交付构建。

新增 owner 生命周期测试与既有 IAM/Registry 回归、Moss 协调器/SDK/权限/响应读取测试通过。真实记录保留在隔离验收环境，私有配置与凭证不进入仓库。完整检查结果及精确提交在批次交接记录中归档。

仍需：独立迁移前基线与固定阈值对比、L2 证据准入、标准托管 Task 与 Work 调用、异常容器清理的可恢复证明、全部协议计量、工具/IM/成本及其余 1.1 验收。本功能不宣称完整 R2、R3 或 Agent 管理 1.1 完成。

## 原平台基线与迁移对比

管理路径：智能体管理 → 智能体台账 → 托管制品 → 迁移基线与托管评测。

1. 保存不可变评测集，选择与原平台发布内容相匹配的已登记制品。
2. 选择“原平台基线”。Dify 使用部署指定的原应用，在调用前校验工作区、API Key 所属应用、已发布 workflow 导出与登记执行计划。草稿不能作为已发布版本。
3. 原平台返回的请求／workflow／message／task／conversation 编号通过 evaluator-only API 逐步持久化；后续失败仍保留。编号只能增补，不能替换。没有必要执行编号的成功报告会被拒绝。
4. 全部用例结束且清理确认后，管理员输入最低通过率和最大允许下降。阈值保存后不可改写，同时绑定基线、制品、资产元数据与数据集／评分规则。
5. 新建托管候选时引用既存阈值。完成后点击“生成／读取迁移对比”；Registry 从持久化的全部样本计算结果，不接收浏览器提供的分数或成功标志。

Dify 的原平台版本证据是执行前后观察到的发布快照，不是远端不可变版本承诺。原平台编号来自 Dify，不代表费用已经由本地 Router 核验。托管运行的模型调用仍由实际 IAM → Nexus 内容出口 → Router 路径执行并单独核对账单。通过合成数据集的迁移对比不自动授予 L2，还需权限、停用、工具、隔离与显式审核的证据。

### 部署配置

`MOSS_AGENT_HOSTED_CONFIG_FILE` 增加可选 `sourceBaselines` 数组。每个 Dify 项包含：

- `profile: "dify-service-api-v1"`、`orgId`、`assetId`。
- `origin`、`workspaceId`、`appId`，仅部署管理员可设定，浏览器不能覆盖。
- `apiKeyFile`、`consoleTokenFile`、`csrfTokenFile`，引用绝对路径、仅文件所有者可读的凭据文件。凭据不写入制品、评测记录或日志；每次执行重新读取文件，凭据轮换会使原快照失配。

凭据不足、原平台发布内容变化、负责人离开组织或当前管理员授权被撤销均会阻断新调用。已开始／结果未知的用例不自动重发。更新 owner 和消费者时先备份，再显式初始化新增的评测／阈值／对比表；普通服务启动不迁移数据。

### 2026-10-21 集成验证

隔离实验环境实际 Dify 1.14.2 的六个合成算术样本，通过管理页面执行原平台基线（6/6），固定最低100%／最大下降0百分点，再执行真实固定镜像托管候选（6/6）并生成成功对比。六笔候选模型调用均核对 Router 账单及临时凭据回收。Dify 原平台运行编号分别保存。无效负责人的旧实验资产被页面正确拒绝，没有降低成员校验。

完整 Node 回归1211通过、7跳过；本批聚焦20通过。管理类型检查通过，服务端类型基线104未增加。以上证据只覆盖所述合成场景，不能作为 PostgreSQL HA、完整业务迁移或 Agent管理1.1全部需求的验收结论。

### LangGraph 原工程基线

`sourceBaselines` 还支持 `profile: "langgraph-source-v1"`，配置 `orgId`、`assetId`、`python`、`entry`、`project`。后三项为部署指定的绝对路径：独立 Python 环境、Nexus 的 `langgraph_source.py` 和已审阅的单文件原工程。原工程必须提供 `build_graph(model, trace)`；当前支持官方 LangGraph1.0.5。浏览器不能提交这些路径或自动执行上传代码。

运行器先读取原工程源码并生成摘要、依赖版本列表与自身摘要，创建基线时固定这些信息；子进程再次核对后直接编译已检查的源码字节。原工程进程不继承管理进程的密钥环境，模型请求通过有调用上限的 IPC 回调走真实 IAM、Nexus 出口与 Router。结果在进程正常退出且清理确认后才可成功。此原工程环境不是 L2 沙箱，不能用来执行未审阅上传代码或生产敏感数据；迁移后的候选仍在原有严格容器运行器中执行。

同一管理页面实际完成 LangGraph 原工程6/6 → 固定最低100%／最大下降0百分点 → 托管候选6/6；前后12次模型调用均为实际模型运行并核对 Router 账单。测试资产与评测集由隔离实验初始化准备，运行、固定阈值和生成对比均通过管理页面操作。

## Task runtime rollout boundary

The next hosted execution profile uses canonical Moss `tasks`, `sessions`,
`session_attempts` and `session_events`; it does not create a second task store or
pretend that a Docker artifact is an external HTTP Provider. `hosted` sessions
map to the `hosted_artifact` engine and cannot start or attach native scode
runners. Native recovery/listing accepts only its four owned runtimes.

External task readers and maintenance use the `external_tasks` read view, scoped
by canonical session runtime and matching organization/user. Updates also check
that scope before acquiring a task row lock. Request-key lookup deliberately
remains global across runtimes: a changed body conflicts, and an external-only
caller cannot project a hosted record as an ExternalTask. Timeout, execution
claim, reconciliation and retention cannot touch other runtime records.

The view is an additive, idempotent initialization on a canonical database.
Legacy task-table cutover still requires the explicit maintenance migration.
Before enabling hosted task creation, upgrade every controller sharing the
canonical database: older controllers do not contain these runtime filters.
This storage preparation alone does not enable hosted publication, Work calls,
or qualify hosted task recovery/HA.

Validation: shared SQLite/PostgreSQL isolation scenarios preserve hosted task,
session, attempt and event bytes through external reads, recovery, timeout,
retention and restart; the existing PostgreSQL external controller SIGKILL and
independent-pool regressions exercise their original runtime only.
