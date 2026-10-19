# 园区咨询部署约定

本模块实现计划中的 P0/P1 园区业务。首次使用时，Moss 的 `PARK_ORG_ID` 必须设置为现有园区组织 ID；服务会在第一次园区请求时创建业务表。园区系统运营人员先通过独立园区端的 `/park/admin/policies` 保存园区名称、简介和服务目录，再录入并发布政策。公开咨询在此之前返回 503，不展示模拟业务数据。

园区三类角色独立于 Moss 通用角色。现有组织管理员使用 Moss 授权令牌调用 `PUT /api/v1/parks/{orgId}/roles/{userId}`，请求体为 `{"park_role":"park_leader"}`、`park_recruiter` 或 `park_system_operator`。园区 API 每次从数据库读取授权；桌面端和 guest 均不能进入园区管理页。

公开咨询和内部页面均由 Sudowork 的 `apps/park` 构建，同一服务提供 `/consult`、`/park/*`，并代理 `/public/*` 至 Moss。`PARK_PUBLIC_URL` 应填完整公开地址，供公开链接和二维码使用。公开会话有效期固定为 24 小时，联系方式留存期限为 180 天。线索规则达到 40 分时异步生成匿名潜在线索。邮件作为可留存联系方式，当前没有邮件验证码；填写手机时必须通过一次性短信验证码，未验证不能标记为已验证。

公开端与 Moss 配置相同的 `PARK_PUBLIC_PROXY_HMAC_KEY`，用于把真实访客 IP 送入 IP/网段限流；密钥缺失时 Moss 使用代理连接 IP。若公开端前面还有反向代理，在公开端配置 `PARK_TRUSTED_FRONT_PROXY_IPS`（逗号分隔的直接上游 IP），仅对这些上游读取 `X-Real-IP` 与 `X-Forwarded-Proto`。反向代理须覆盖这两个请求头，不能透传访客提交的同名头。

Assistant 选用组织已配置的 OpenAI 兼容 chat completions 模型。系统运营页发布 Assistant 时检查模型服务与密钥；公开回答只检索当前生效且已发布的政策及园区简介、服务目录。模型不可用时返回依据摘录；无依据时明确提示联系园区。园区资料和密钥不在公开配置接口中输出。

P1 短信复用 Moss 的短信服务配置，还需 `PARK_SMS_HMAC_KEY`（至少 32 字符）；CAPTCHA 需 `PARK_CAPTCHA_HMAC_KEY`（至少 32 字符）。盒子运维功能需在验收盒子中配置 `PARK_BOX_BACKUP_DIR`、`PARK_BOX_UPGRADE_DIR`、`PARK_BOX_UPGRADE_PUBLIC_KEY` 及所需固定可执行程序 `PARK_BOX_BACKUP_BIN`、`PARK_BOX_RESTORE_BIN`、`PARK_BOX_UPGRADE_BIN`、`PARK_BOX_ROLLBACK_BIN`、`PARK_BOX_REINDEX_BIN`、`PARK_BOX_MODEL_CHECK_BIN`。可选 `PARK_BOX_HEALTH_URLS`（逗号分隔）与 `PARK_BOX_VERSION`。没有配置的操作会返回 503；升级包必须通过 Ed25519 签名校验，升级失败调用回滚程序。

本地服务测试：`node scripts/run-node-tests.js park`。跨应用浏览器测试：在 Sudowork 根目录运行 `bun run --filter '@sudowork/park' test:e2e`，脚本构建园区应用，并启动带政策、角色数据的 SQLite Moss 测试实例和 Park 服务；不启动 WebUI。该测试使用固定账号与园区角色、短信发送日志和隔离的盒子运维钩子。真实短信送达、实际备份恢复和升级回滚必须在配置完成的盒子验收环境中运行。
