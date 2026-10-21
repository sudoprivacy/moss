# 托管制品管理与当前交付边界

这批代码提供 Dify DSL 校验和已构建制品登记界面。运行器和构建工具由 Nexus
维护，Moss 消费 SudoStack 从 Nexus 精确提交分发的实验契约。

## 管理操作

1. 在“智能体管理 → 智能体台账”登记 Dify 或 LangGraph 资产，选择“内部托管”，
   指定当前组织的负责人和模型资源。
2. 部署人员按照 Nexus `docs/agent-hosted-profile.md` 准备受支持的源文件、完整
   依赖包和固定镜像，提供含真实镜像摘要的 `HostedImage` JSON。当前页面不执行构建。
3. 点击该资产行的“托管制品”，上传镜像描述文件。Dify 同时上传原始 DSL，可先
   点击“校验 DSL”查看支持情况；错误定位到具体字段，不显示文件中的敏感内容。
4. 点击“登记制品”。服务端重新核对负责人、组织、台账资料摘要、来源平台、模型
   资源、源文件及镜像描述。客户端填写的等级、签发者和组织信息不能替代这些检查。
5. 在已登记列表查看规格和镜像摘要。重复提交同一请求不会重复登记。负责人可以
   查看自己的制品，只有当前组织管理员能导入。

登记记录不是发布记录。导入不会启动容器，不会授予使用权限，不会切换频道或
提升纳管等级。资料变更后，旧制品显示其对应旧资料，重新执行仍需通过准入。

## 运行与验证

真实样例使用 Dify 1.14.2 导出的 DSL、官方 LangGraph 1.0.5 工程和同一模型
`gemini-3-flash-preview`。两种固定镜像均通过断网构建，并由 Nexus 正式 supervisor
在无网络、只读根目录、非 root 和资源限额下执行。模型请求在容器外通过现有
IAM 短期委派和实际 Router 计量；两种样例各 6/6。数据是合成算术题。

实际 Moss/AuthCenter → Nexus 管理 API 还验证了管理员导入、负责人只读、跨组织
拒绝、源文件匹配、幂等及不能通过导入提升等级。浏览器实际操作验证了文件上传、
DSL 校验、登记成功和不支持节点的报错。

## 后续增量已接通的链路（2026-10-21）

持久化任务、版本化评测集、原平台基线、迁移阈值与前后对比、审核发布和 Work
统一对话均已实现。Dify 与官方 LangGraph 样本分别完成 6/6 的原平台与托管比较，
再经独立验收审核、固定版本发布和真实 Work 任务验证。正式 `run` 模型调用强制
经过 Nexus 内容路径、IAM 与 Router；不具备该路径的直接模型配置仍会被拒绝。

停用/恢复、未知结果、控制器崩溃、容器清理和 PostgreSQL 并发已有专项证据；
工具网关和可信成本展示也已接通。入口及故障处理见
[托管任务](agent-hosted-tasks.md)、[评测](agent-hosted-evaluations.md) 和
[任务授权](agent-task-execution-context.md)。这些结果限定于受支持的合成文本样本。

仍未完成：AM-16 六项契约原生转换、完整离线内网模型验收及整套部署验收。
L3 目前不能仅凭报告中的 `native` 标记或 L2 对比授予；Nexus 会返回
`AGENT_NATIVE_CONVERSION_REQUIRED`，旧 L3 报告也无法绕过发布和执行检查。
真实 IM 样例按用户决定后置。以上不代表全部 Agent 管理 1.1 或生产验收通过。

部署镜像和源制品管理是本期运行所必需的服务能力；桌面安装包和签名继续后置。

## Versioned migration datasets

The same hosted-artifact dialog now includes “迁移评测集”. A manager creates a
name/version and one or more synthetic-text input/expected-output pairs. The
immutable owner API binds these to the current asset metadata and the
`exact-strip-v1` rubric. Owners can read their datasets; other users cannot read
another owner's sample content. Only authenticated managers can write, with the
actual authenticated user supplied by Moss. Identical request replay is safe;
changing an existing name/version is rejected and requires a new version.

The form stores inputs and expected results. The adjacent hosted evaluation panel
now runs registered artifacts against them; see [hosted evaluations](agent-hosted-evaluations.md).
A completed migration comparison and publication/grade admission remain separate requirements.
