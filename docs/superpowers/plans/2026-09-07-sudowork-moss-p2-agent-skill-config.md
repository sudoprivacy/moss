# Sudowork 整合 P2 Agent、Skill、配置与 Nexus 实施计划

> **执行约束：** 全程在 `codex/sudowork-moss-consolidation` 工作树内按 TDD 小步实施；每项先得到失败测试，再实现并运行局部回归。不得修改 Sudowork 客户端与旧服务仓库，不得暂存、提交或推送。

**目标：** 以 Moss 现有 `tenant_assistants`、`tenant_skills`、`config_items`、Nexus 和制品目录为唯一主数据，使本地模式与企业云端模式读取同一套 Agent、Skill、可见性和配置；旧 Sudowork 接口只做认证、字段、分页、文件和错误协议转换。

**边界：** 本阶段建立 Dify Provider 元数据和绑定入口，但不实现 Dify 对话、会话、数据集和音频执行，这些属于 P4。不得把旧 Sudohub 代理或旧表复制进 Moss。

## Task 1：冻结 P2 接口与数据映射

- [ ] 从固定旧提交提取 P2 路由、查询参数、请求体、状态码、响应字段、分页游标和文件行为。
- [ ] 为 `/api/assistants/*`、`/api/skills/*`、`/api/categories`、`/api/v1/agents/visible*`、配置项、系统配置、租户配置和上传接口建立 Fixture。
- [ ] 除 216 条旧服务路由外，从未修改的受支持 Sudowork 客户端提取 SkillHub/AssistantHub 出站接口；该外部依赖也必须由 Moss 接管后才能声明目录完成整合。
- [ ] 建立旧资源 ID、Moss 主键、Organization 和 Provider 永久 ID 的映射表；名称只报告冲突，不自动合并。
- [ ] 明确 P2 与 P4 的路由边界，防止用占位响应掩盖尚未实现的 Dify 执行能力。

验证：Fixture 提取测试与 216 路由总契约通过。

## Task 2：扩展统一 Agent/Skill 主模型

- [ ] 为 `tenant_assistants` 增加 `provider_type`、`provider_binding`、`supported_modes`、`artifact_version` 等通用字段。
- [ ] 为 `tenant_skills` 增加 `supported_modes`、`artifact_version` 等通用字段。
- [ ] 增加数据库约束与索引，限制 Provider 类型、模式、状态及组织范围。
- [ ] 对现有 Moss 数据执行幂等回填：默认 Agent 为 `moss_runtime/both`，Skill 为 `both`，不破坏现有行。

验证：新库、旧库升级、重复启动、非法枚举、组织隔离和回填测试通过。

## Task 3：统一 Catalog Repository 与领域服务

- [ ] 新建 Agent/Skill Catalog Repository，统一封装查询、游标、审批、更新和删除。
- [ ] 实现用户、组织管理员、平台管理员三类可见性与审批边界。
- [ ] 本地模式只返回 `local|both`，云端模式只返回 `moss_runtime|dify` 且支持 `cloud|both` 的资源。
- [ ] Agent 与 Skill 关联只保存统一 Skill ID；Provider binding 不拥有 Agent 主数据。
- [ ] 创建、更新、审批和删除通过统一命令与 SQLite UnitOfWork 执行，事务期间不得 `await`。

验证：跨组织不可见、角色越权、模式过滤、游标稳定性、幂等审批和回滚测试通过。

## Task 4：统一制品与 checksum

- [ ] 将 Agent/Skill 上传、暂存、审批发布和下载接到 Moss 现有制品目录。
- [ ] 上传先写临时文件并校验格式、路径和大小；数据库提交后原子发布，失败时清理临时文件。
- [ ] 下载按主数据中的 `file_path` 和 `checksum` 校验，拒绝目录穿越、缺失文件和 checksum 不一致。
- [ ] 历史制品导入保留原始资源 ID、版本和 checksum；checksum 相同可去重，名称相同只报告冲突。

验证：上传、审批、下载字节、Content-Type、Content-Disposition、缺失文件、路径穿越和失败清理测试通过。

## Task 5：统一配置定义与 Nexus 密钥

- [ ] 复用 Moss `config_items/config_entries`，补齐旧 `visible_to_all` 与组织关联语义，不新增 Sudowork 配置表。
- [ ] 所有敏感值只写 Nexus；SQLite 只保存定义、组织关系、密钥引用和脱敏状态。
- [ ] 统一管理接口与 Auth Proxy 使用同一配置服务，禁止任何列表、详情、日志或错误返回真实密钥。
- [ ] 更新配置项与 entries 使用 UnitOfWork；跨 SQLite/Nexus 通过补偿、校验和审计保证，不宣称全局事务。

验证：组织隔离、关联/取消、禁用清理、entries 替换回滚、Nexus 写失败补偿和全响应秘密扫描通过。

## Task 6：Sudowork Agent/Skill 兼容接口

- [ ] 将 `/api/assistants` 的游标、详情、上传、审批、删除映射到统一 Agent Catalog。
- [ ] 将 `/api/skills` 的游标、详情、上传、审批、删除映射到统一 Skill Catalog，并实现 `/api/categories`。
- [ ] 将 `/api/v1/agents/visible` 与 `/visible/bindings` 映射到同一 Catalog 和 Provider metadata。
- [ ] 保持旧游标、筛选、租户字段、状态值、错误文案、multipart 和 JSON envelope；`skillhub_baseurl` 切换到 Moss 后不再以 Sudohub 为运行时主数据。

验证：逐接口 Fixture/差异测试通过；本地与云端查询相同资源 ID、版本、可见性和 checksum。

## Task 7：Sudowork 配置兼容接口

- [ ] 实现 `/api/v1/admin/config-items*` 全部 10 条管理路由并复用统一配置服务。
- [ ] 实现 `/api/v1/config/items`、`/api/v1/system-config`、`/api/v1/system-config/credentials`、`/api/v1/tenant/config`。
- [ ] 实现配置图标与企业 Logo 上传，沿用 Moss 安全文件存储并保持旧 URL/响应契约。
- [ ] 系统级开关投影到组织策略；旧全局单例只能作为迁移输入，不能继续作为主数据。

验证：旧客户端 Fixture、权限边界、上传安全、凭据加密格式和真实密钥零泄漏测试通过。

## Task 8：迁移入口与 P2 门禁

- [ ] P2 导入命令只调用统一 Repository/领域命令，并使用 `migration` 上下文抑制外部 Outbox 副作用。
- [ ] 导入可重复执行，输出 Agent/Skill/配置/制品的数量、归属、版本、checksum、冲突和孤儿报告。
- [ ] 运行 Node/Bun 全量测试、Node 构建、216 路由契约和客户端矩阵校验。
- [ ] 未修改旧服务和客户端，工作树无暂存、提交和推送。

**P2 完成门禁：** 本地与云端模式从同一主数据读取资源；旧上传和下载契约通过；任何 HTTP 响应、日志和 SQLite 行均不包含 Nexus 中的真实密钥。真实历史客户端验收仍需在迁移演练环境完成，`candidate` 客户端矩阵不得提前改成 `confirmed`。
