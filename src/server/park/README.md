# 园区咨询部署约定

本模块实现园区公开咨询与内部运营业务。首次使用时，Moss 的 `PARK_ORG_ID` 必须设置为现有园区组织 ID；服务会在第一次园区请求时创建业务表。园区系统运营人员在 `/park/admin/policies` 上传政策文件、创建并构建 Wiki，然后将已构建 Wiki 绑定到公开 Assistant。公开咨询在 Assistant 发布前返回 503，不展示模拟业务数据。

园区三类角色独立于 Moss 通用角色。现有组织管理员使用 Moss 授权令牌调用 `PUT /api/v1/parks/{orgId}/roles/{userId}`，请求体为 `{"park_role":"park_leader"}`、`park_recruiter` 或 `park_system_operator`。园区 API 每次从数据库读取授权；桌面端和 guest 均不能进入园区管理页。

公开咨询和内部页面均由 Sudowork 的 `apps/park` 构建，同一服务提供 `/consult`、`/park/*`，并代理 `/public/*` 至 Moss。`PARK_PUBLIC_URL` 应填完整公开地址，供公开链接和二维码使用。公开会话有效期固定为 24 小时，联系方式留存期限为 180 天。线索规则达到 40 分时异步生成匿名潜在线索。邮件作为可留存联系方式，当前没有邮件验证码；填写手机时必须通过一次性短信验证码，未验证不能标记为已验证。

公开端与 Moss 配置相同的 `PARK_PUBLIC_PROXY_HMAC_KEY`，用于把真实访客 IP 送入 IP/网段限流；密钥缺失时 Moss 使用代理连接 IP。若公开端前面还有反向代理，在公开端配置 `PARK_TRUSTED_FRONT_PROXY_IPS`（逗号分隔的直接上游 IP），仅对这些上游读取 `X-Real-IP` 与 `X-Forwarded-Proto`。反向代理须覆盖这两个请求头，不能透传访客提交的同名头。

Assistant 选用 Moss 组织已配置的 OpenAI 兼容 chat completions 模型，园区端不单独配置模型。系统运营页发布 Assistant 时检查组织模型、已构建 Wiki 和 `park-consultation-tools` skill。政策工具检索并保留文档身份、版本和行范围；公开运行时明确成功完成后，服务端在同一事务内保存咨询、完成状态、消息计数及异步任务，再发送 SSE done。兼容 inquiry/lead 工具只提供建议，不再独立创建记录。园区资料和密钥不在公开配置接口中输出。

每条咨询都进入结构化提取任务，复用组织模型，校验用户原文证据后更新主题、意图、行业、规模、紧迫度和关注点；未提供信息保留空值，否定或不确定意向不生成高意向线索。任务最多尝试三次，失败保留状态；服务重启恢复 processing 任务，将中断回答标记为 interrupted，令对应公开会话过期并终止其运行会话。提取结果更新线索评分时保留人工认领和处理状态。

领导四个聚合接口保留原地址，增加 as_of、上海日期期间及 data_quality。咨询量仅计确认完成的咨询；主题仅计提取完成的记录。政策关注按回答中可核对身份与检索行范围的引用计数，每条咨询每文档计一次。渠道分别列出新增会话、咨询会话、首次留联线索和首次转化线索，不以堆叠或漏斗假设互相包含。认领、留联和转化使用不可覆盖的首次事件时间；跟进以实际记录为准。当历史已转化线索缺少事件时，月度转化量返回 null，同时提供 verified_converted；页面显示无法确定。领导角色即使拥有通用管理员权限，也不能读取公开原始会话或连接会话 WebSocket。

历史恢复先执行只读检查：`node --import tsx scripts/recover-park-leadership-history.ts <moss.db> <org-id>`。只有问答、公开请求 ID、对应请求的明确成功结果及完成时间均可验证的记录才可恢复；追加 `--apply` 才写入。已有记录、旧问答映射歧义、缺少成功证据均保留供人工审核。该工具不猜测历史政策版本，不删除或合并历史记录。

短信复用 Moss 的短信服务配置，还需 `PARK_SMS_HMAC_KEY`（至少 32 字符）；CAPTCHA 需 `PARK_CAPTCHA_HMAC_KEY`（至少 32 字符）。盒子运维功能需在验收盒子中配置 `PARK_BOX_BACKUP_DIR`、`PARK_BOX_UPGRADE_DIR`、`PARK_BOX_UPGRADE_PUBLIC_KEY` 及所需固定可执行程序 `PARK_BOX_BACKUP_BIN`、`PARK_BOX_RESTORE_BIN`、`PARK_BOX_UPGRADE_BIN`、`PARK_BOX_ROLLBACK_BIN`、`PARK_BOX_REINDEX_BIN`、`PARK_BOX_MODEL_CHECK_BIN`。可选 `PARK_BOX_HEALTH_URLS`（逗号分隔）与 `PARK_BOX_VERSION`。没有配置的操作会返回 503；升级包必须通过 Ed25519 签名校验，升级失败调用回滚程序。

本地服务测试：`node scripts/run-node-tests.js park`。跨应用浏览器测试：在 Sudowork 根目录运行 `bun run --filter '@sudowork/park' test:e2e`，脚本构建园区应用，并启动带政策、角色数据的 SQLite Moss 测试实例和 Park 服务；不启动 WebUI。该测试使用固定账号与园区角色、短信发送日志和隔离的盒子运维钩子。真实短信送达、实际备份恢复和升级回滚必须在配置完成的盒子验收环境中运行。
