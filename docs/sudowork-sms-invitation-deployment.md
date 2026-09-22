# Moss 接入 SudoWork：短信登录与邀请码注册部署指南

适用版本：Moss [PR #285](https://github.com/sudoprivacy/moss/pull/285)（功能提交 `e7532fe`，包含前置提交 `c9c1b7d`）与 SudoWork [PR #1156](https://github.com/sudoprivacy/sudowork/pull/1156)（`7391498f`）。本文按 2026-09-22 的分支代码核对。部署前确认目标版本包含这些提交，不能把尚未合并的 PR 当作现有 `dev` 已具备的能力。

## 1. 两个 PR 分别做了什么

| PR | 改动 | 对使用者的影响 |
| --- | --- | --- |
| Moss #285 | 统一生成 **6 个字符**的邀请码，继续接受已经发出的旧邀请码 | 原生后台与兼容后台生成规则一致；邀请码不是固定的 6 位纯数字 |
| Moss #285 | SudoWork 注册、Moss 后台创建用户统一接入 Sudorouter 开户、初始额度与用户 API Key 分配；支持创建重试 | 用户注册后可使用自己的网关账号；登录可补齐此前未完成的网关配置 |
| Moss #285 | 网关用户名保持账户名；初始密码为账户名，不足 8 个字符在右侧补 `1` | 例如 `moss922` 的网关初始密码为 `moss9221`；不会在后续登录时重置已存在网关账户的密码 |
| Moss #285 | 后台用户列表显示脱敏 API Key，授权复制接口有组织权限检查、审计和 `no-store` | 管理员可复制完整密钥，列表响应不会直接返回完整密钥 |
| Moss #285 | 按用户网关 Key 发现、选择和调用模型，隔离模型缓存，传递模型上下文及输出限制 | 修复注册后模型不可选、使用错误凭据等问题 |
| Moss #285 | ACP 请求失败时返回失败结果并解除等待状态；修复内置技能目录缺失引用 | 请求出错后客户端可以结束等待并继续操作 |
| Moss #285 | 后台充值、积分调整、额度同步独立于富友支付开关；补充余额、整数范围和操作类型校验；修正账本类型 | 不开在线支付也能管理网关额度；充值记为 `RECHARGE`，调整记为 `ADJUST` / `DEDUCT` |
| SudoWork #1156 | 不再把 `Remote Agent`、`Moss Server` 两个默认显示名称当作真实助手标识发送 | 修复默认远程对话找不到助手、返回 404 的问题；真实助手 ID / 名称仍保留 |
| SudoWork #1156 | 模型名称优先使用服务器的 `label` / `name`；只把明确的默认值识别为“默认模型” | `legacy-default:gpt-4o` 正确显示为 `gpt-4o` |

SudoWork 的短信登录和邀请码注册接口已经存在；本次桌面 PR 修复的是登录后的远程对话与模型展示。短信发送、组织准入、网关开户及额度管理由 Moss 配置和执行。

**密码边界：**短信注册以手机号作为账户名，昵称只用于显示；它不等于创建了一个 Moss 长期密码。后台添加用户时填写的 Moss 密码会保留，Sudorouter 初始密码仍按上述账户名规则生成，两边后续密码修改也不自动同步。这个初始密码容易推测，正式开放网关控制台前应安排修改；本 PR 没有实现强制首次改密。

## 2. 部署组成与地址

```text
SudoWork ── HTTP / WebSocket ── Moss ── 用户管理、额度管理 ── Sudorouter
                                 ├── 用户模型 Key ── 模型发现和推理
                                 ├── Nexus ── 保存敏感凭据及用户 Key
                                 ├── 腾讯云短信 / 开发日志 ── 发送验证码
                                 └── Scode ── 执行远程会话
```

需要准备：

- 包含上述 PR 的 Moss 服务与 SudoWork 客户端。
- Node.js、Bun、项目依赖；本次本机验证使用 Node.js 24，仓库 Docker 镜像使用 Node.js 22.22.1。以下命令针对单机源码部署。
- 可用的 Nexus 及 vault 插件。单机默认由 Moss 管理嵌入式 Nexus；外部集群用 `MOSS_NEXUS_MODE=external` 等变量接入，见 [Nexus 环境配置](../src/server/nexus/nexusEnvConfig.ts)。
- 与客户端兼容的 Scode。优先使用当前部署制品配套版本和 [运行时清单](../src/server/nexus/runtime-versions.json)。本次会话实际验证了 Scode 0.2.11；旧的 0.1.12 没有正确应用模型限制。清单中的版本不等同于本次实测版本。
- Sudorouter 根地址、管理员 API Token、该 Token 对应的管理员用户 ID。该凭据需有查询/创建用户、创建 Token、调整额度的权限。
- 正式发送短信时，需要腾讯云 SMS 应用、已审核签名和模板，以及有发送权限的 SecretId / SecretKey。

| 地址 | 填在哪里 | 示例 |
| --- | --- | --- |
| Moss 对客户端的地址 | SudoWork 自定义服务器地址 | `https://moss.example.com`；同一台机器联调可用 `http://127.0.0.1:43127` |
| Sudorouter 根地址 | Moss 的 Sudorouter 基础设施配置 | `https://router.example.com`，不带 `/v1` |
| 模型服务地址 | Moss 模型服务商设置 | `https://router.example.com/v1` |
| 模型发现地址 | Moss 模型服务商设置 | `https://router.example.com/v1/models` |
| 管理后台 | 浏览器访问 | `https://moss.example.com/admin` |

客户端应填写 **Moss 地址**，不是 Sudorouter 地址，也不要附加 `/admin` 或 `/api/v1`。远程用户不能填写 `127.0.0.1`，它指向用户自己的电脑。公网部署需让反向代理同时支持普通 HTTP、WebSocket 升级和持续响应；Moss 到 Sudorouter、Nexus 的连通性也必须成立。

## 3. 构建与首次启动

在已经检出的 Moss 目标版本根目录执行：

```bash
bun install --frozen-lockfile
(cd admin && bun install --frozen-lockfile)
bun run build:node
```

源码部署应保留所需运行依赖，从仓库根目录启动，不能只复制一个 `moss-server.mjs`。构建会生成后台静态文件及会话 runner。

macOS / Windows 的非 CI Node 构建会尝试获取 Nexus 运行文件，失败可能只输出警告；启动仍会检查实际文件。Linux 应使用准备好 Nexus/vault/Scode 的部署制品或仓库 Docker 部署流程，不能假设该自动下载脚本覆盖 Linux。容器部署参考 [服务镜像](../deploy/server.Dockerfile) 和 [Compose](../deploy/docker-compose.yml)；这些文件还包括与本任务无关的业务依赖，使用前按目标环境准备构建输入。

### 3.1 配置文件

默认读取运行用户的 `~/.moss/server/server.json`，也可以用 `MOSS_SERVER_CONFIG` 指定。已有部署应合并必要字段，保留原来的存储路径和组织数据。

先创建配置目录：

```bash
mkdir -p "$HOME/.moss/server"
```

下面是开发联调示例，将它保存到所选的 `server.json`（默认 `~/.moss/server/server.json`）。启动前替换管理员密码和 Scode 路径；如果由同一台机器测试，可把监听地址改为 `127.0.0.1`。

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 43127
  },
  "auth": {
    "mode": "local",
    "tokenTtlSec": 3600
  },
  "bootstrapAdmin": {
    "username": "admin",
    "password": "REPLACE_WITH_YOUR_ADMIN_PASSWORD"
  },
  "runtimeDefaults": {
    "type": "host",
    "engine": "scode",
    "hostScodePath": "/absolute/path/to/scode",
    "idleTimeoutMs": 600000,
    "maxSessions": 32
  },
  "phoneAuth": {
    "enabled": true,
    "delivery": "log",
    "codeTtlSec": 300,
    "resendCooldownSec": 60,
    "maxSendsPerHour": 5,
    "maxVerifyAttempts": 5,
    "autoCreateOrg": false
  },
  "systemConfig": {
    "loginMethod": 0,
    "authMethods": ["phone", "password", "api_key"],
    "rechargeMode": "disabled"
  },
  "sudoworkCompatibility": {
    "enabled": false
  }
}
```

- `phoneAuth.enabled` 打开原生短信接口；`systemConfig.loginMethod: 0` 表示客户端默认展示短信登录，`authMethods` 声明可展示的入口。实际是否准许某种登录，还受组织策略限制。
- `bootstrapAdmin.password` 仅用于初始化；已有管理员不会因编辑此字段而被重置密码。文件只交给服务运行用户读取。
- `autoCreateOrg: false` 保持邀请加入已有组织。当前交互式注册始终要求组织邀请码，不自动给每个手机号创建组织。
- 当前 SudoWork 使用原生 `/api/v1/auth/*` 接口，**不需要开启旧的 `sudoworkCompatibility.enabled`，也不需要为这条短信流程配置兼容 Redis**。
- `MOSS_PHONE_AUTH=1`、`MOSS_LOGIN_METHOD=0` 可以覆盖对应文件开关；组织准入策略不是这两个变量控制的。

```bash
chmod 600 "$HOME/.moss/server/server.json"
export MOSS_SERVER_CONFIG="$HOME/.moss/server/server.json"
node bin/moss-server.mjs
```

新环境先不配置 Sudorouter 地址和 Token，完成首次启动、管理员登录后按下一节配齐它们。不要只设置地址而遗漏 Token：不完整的网关配置会阻止启动。若已有网关配置则保留，不必清空。

上面的 Node 命令在前台运行并占用终端；保持服务运行，在第二个终端检查：

```bash
curl --fail http://127.0.0.1:43127/healthz
curl --fail http://127.0.0.1:43127/api/v1/system-config
```

第二个接口应包含 `data.auth_methods` 中的 `phone`，以及 `data.registration.phone_enabled: true`、`invitation_required: true`、`auto_create_org: false`。按示例配置时 `data.login_method` 为 `0`。

## 4. 配置 Sudorouter、用户 Key 与模型

### 4.1 管理凭据和开户地址

1. 使用初始化管理员登录 `/admin`。
2. 打开 `/admin/settings/server-credentials`，保存 **“Sudorouter 兼容账务 Token”**（字段 `billing.sudorouter.apiToken`，配置键 `server.sudorouter-api-token`）。这个名称也用于本次统一开户和后台额度功能。不要误填到旧的 `server.sudorouter-admin-token` 后就认为全部配置完成。
3. 打开 `/admin/operations/sudowork-settings`，选择**平台范围**，只修改 Sudorouter 相关字段：根地址、管理员 ID、超时和初始模型额度。保持在线支付关闭；不需要填写富友商户密钥。
4. 保存并重启 Moss，确认 `/healthz` 正常。

也可由部署系统注入下面的环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `SUDOROUTER_BASE_URL` | 网关根地址 |
| `SUDOROUTER_API_TOKEN` | 管理 Token；可改用上述后台凭据项存入 Nexus |
| `SUDOROUTER_ADMIN_USER_ID` | 管理 Token 对应的管理员用户 ID，不能填新注册用户的 ID |
| `SUDOROUTER_TIMEOUT_MS` | 网关请求超时，默认 10000 毫秒 |
| `USER_INITIAL_QUOTA` | 后台创建用户等入口的默认初始网关额度 |

运行时优先读取环境变量，未设置时读取平台基础设施配置和 Nexus 凭据。因此改了后台却不生效时，应检查服务进程是否仍有旧环境变量。管理 Token 和已分配的用户 Key 都不应提交进代码或本文。

积分换算：**1 积分 = 500 个 Sudorouter quota 单位**；数据库钱包用 100 个子单位存储 1 积分。例如 `100000 quota = 200 积分`。邀请码还可指定注册初始额度；不要把后台默认 quota、邀请码的美元输入和数据库子单位混为一个单位。修改默认额度不会自动修改既有用户余额。

### 4.2 模型设置也要配置

仅配好开户地址，并不等于模型服务商已经配置完成。

在 `/admin/settings` 的模型设置中，为平台或目标组织启用指向同一 Sudorouter 的模型服务商，配置模型服务地址和 `/v1/models` 发现地址，选择用户实际有权限调用的默认模型。本次测试环境使用 `gpt-4o` 成功对话；其他环境应以自身网关授权的模型为准。

`/admin/operations/sudowork-settings` 中的“客户端模型服务地址”“可用模型列表地址”属于兼容基础设施字段，不能替代原生模型服务商设置。用户会话使用该用户分配的 Key，不应把管理员管理 Token 填为所有用户共用的模型 Key。

## 5. 准备允许短信登录的业务组织

邀请码决定注册用户加入哪个组织。发短信开关、客户端展示入口、组织允许短信登录，这三项必须一致。

组织登录策略按以下优先级生效：组织客户端策略 `loginMethod` → 平台客户端策略 `loginMethod` → 组织资料 `loginMethod` → 服务默认值。策略仓库内使用 **`loginMethod`**，不是 HTTP 接口字段名 `login_method`。

**当前版本的配置页限制：**“Sudowork 系统设置”页面切换短信登录时，仍校验旧兼容短信通道；即使原生 `phoneAuth` 已正确配置，也可能报“短信通道未配置”。本次 PR 没有统一这两套配置。不要为消除这个提示而开启不需要的旧兼容路由。

对本文的单机 SQLite 部署，可在首次启动产生数据库后，停止 Moss，备份数据库及相关持久化数据，再使用以下一次性初始化步骤。它只给指定的业务组织设置短信策略，保留管理员所在组织的密码登录。使用 Postgres 或托管集群时，应由部署维护者通过同等领域服务执行，不要直接套用本地 SQLite 文件步骤。

在 Moss 仓库根执行，`MOSS_DB_PATH` 必须指向刚才启动所使用的数据库：

```bash
export MOSS_DB_PATH="$HOME/.moss/server/moss.db"
# 新建业务组织时使用固定的名称和代码；重复执行相同输入复用同一创建命令。
export MOSS_ORG_NAME='SudoWork 团队'
export MOSS_ORG_CODE='sudowork-team'
# 若使用已有业务组织，另设置 MOSS_ORG_ID 为该组织 UUID；不要使用管理员组织。
node --import tsx --input-type=module <<'JS'
import { existsSync } from 'node:fs'
import { AuthCenterDb } from './src/server/authCenter/db.ts'
import { AuthService } from './src/server/auth/service.ts'
import { ClientPolicyRepository } from './src/server/configuration/clientPolicyRepository.ts'
import { onlineCommandContext } from './src/server/application/commandContext.ts'

const path = process.env.MOSS_DB_PATH
if (!path || !existsSync(path)) throw new Error('MOSS_DB_PATH 必须指向已初始化的数据库')
const db = new AuthCenterDb(path)
await db.loadSecretCache()
const auth = new AuthService(db, 3600)
try {
  const organizations = auth.createOrganizationIdentityService()
  let orgId = process.env.MOSS_ORG_ID
  if (!orgId) {
    const name = process.env.MOSS_ORG_NAME
    const code = process.env.MOSS_ORG_CODE
    if (!name || !code) throw new Error('缺少业务组织名称或代码')
    const result = await organizations.createOrganization({
      name, code, loginMethod: 'sms', localEnabled: false, cloudEnabled: true,
    }, onlineCommandContext(`deploy:sudowork-org:${code}`))
    orgId = result.organization.id
  }
  if (!(await db.getOrganization(orgId))) throw new Error('业务组织不存在')
  if ((await db.listUsersByRole('super_admin')).some(user => user.orgId === orgId)) {
    throw new Error('请使用独立业务组织，保留超级管理员所在组织的登录策略')
  }
  await db.driver.transaction(async () => {
    await organizations.updateOrganization(orgId, { loginMethod: 'sms' })
    await new ClientPolicyRepository(db.driver).putOrganization(
      orgId, { loginMethod: 0 }, 'deployment:sudowork-phone',
    )
  })
  console.log(JSON.stringify({ orgId, loginMethod: 'sms' }))
} finally {
  auth.destroy()
  db.close()
}
JS
```

随后重新启动 Moss。管理员在后台切换到这个业务组织，再到 `/admin/operations/invitations` 生成邀请码。页面的初始额度默认是 **0 美元**，明确提交 0 就不会继承 `USER_INITIAL_QUOTA`；注册后的积分和网关额度也会是 0。要直接验收付费模型对话，可在生成邀请码时填写 **0.2 美元 = 100000 quota = 200 积分**，或者注册后先由后台充值。邀请码由 6 个大写字母或数字组成，避开部分易混淆字符；每个邀请码使用一次。已有旧邀请码按其原值验证，不会因新生成规则改变而统一失效。

## 6. 模拟验证码与真实短信

### 开发联调：`delivery: "log"`

本节使用第 3 节的 `phoneAuth` 配置，不会真的发送短信。每次仍生成随机 **6 位数字**验证码，在 Moss 服务日志中查找：

```text
[PhoneAuth] DEV DELIVERY — verification code for 199****0001 is <6位验证码>.
```

这是模拟发送方式，不是固定万能码。验证码默认 5 分钟有效、60 秒后可重发、每小时最多 5 次、最多尝试 5 次；成功验证后即消费。API 不返回明文验证码。服务重启以外的读取日志方式取决于进程管理工具，例如前台终端或该服务的日志文件。

`log` 只用于开发联调：能读日志的人就能取得验证码。正式用户短信登录应使用下面的真实短信配置。

### 正式发送：`delivery: "tencent"`

将 `server.json` 的 `phoneAuth` 部分替换为实际的非敏感参数，其他配置保持不变：

```json
{
  "phoneAuth": {
    "enabled": true,
    "delivery": "tencent",
    "codeTtlSec": 300,
    "resendCooldownSec": 60,
    "maxSendsPerHour": 5,
    "maxVerifyAttempts": 5,
    "autoCreateOrg": false,
    "tencent": {
      "sdkAppId": "YOUR_SMS_APP_ID",
      "signName": "YOUR_APPROVED_SIGN_NAME",
      "templateId": "YOUR_APPROVED_TEMPLATE_ID",
      "region": "ap-beijing",
      "templateParams": ["{code}", "{ttlMinutes}"]
    }
  }
}
```

原生短信凭据使用以下配置键，可在 `/admin/settings/server-credentials` 保存：

| 参数 | Nexus 配置键 |
| --- | --- |
| SecretId | `server.sms-secret-id` |
| SecretKey | `server.sms-secret-key` |

当前原生发送器从凭据存储读取密钥，不能只注入 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` 就认为已配置成功。也不要误用旧兼容通道的 `server.sudowork-tencent-secret-*`。原生发送器还兼容 `system:sms` 命名空间下的 `tencent_secret_id` / `tencent_secret_key`，优先使用统一凭据页。

`templateParams` 必须与审核通过的模板占位符顺序一致：只有验证码一个参数时改为 `["{code}"]`。修改发送方式或非敏感参数后重启 Moss；通过凭据页轮换原生短信密钥时，发送器在后续发送时读取新值。

本文环境实测的是日志验证码流程；腾讯云生产发信需在目标环境使用批准的模板和测试手机号实际验收，不能以页面保存成功代替收到短信。

## 7. SudoWork 操作与验收

1. 启动包含 PR #1156 的客户端，在登录页选择/输入 Moss 服务器根地址。切换地址后等待客户端重新读取 `/api/v1/system-config`。
2. 新手机号选择注册，输入手机号、收到的验证码、昵称和业务组织的邀请码。当前手机号支持 11 位中国大陆号码，也接受 `+86` 前缀。
3. 注册成功后，用户应位于邀请码所属组织，Moss 用户列表显示其 Sudorouter 账号/密钥状态，网关存在同名账户。
4. 注销后重新获取验证码，走短信登录，验证已经注册的手机号可以进入。
5. 确认用户已经获得邀请码额度或后台充值后，再打开远程对话，确认能选择授权模型、模型名称正常，发送简单消息并收到回复。
6. 后台对该用户做小额充值、同步加减、本地加减、额度同步和账本查询。测试结束用正常反向调整恢复余额，保留账本记录。

不要先用未注册手机号的验证码登录，再把同一个验证码用于注册：登录验证可能已消费验证码。遇到 `phone_not_registered` 后切换注册并重新获取验证码。

| 验收项 | 预期 |
| --- | --- |
| `/healthz` | HTTP 200，`ok: true`、`ready: true` |
| `/api/v1/system-config` | 宣告 `phone` 入口和邀请注册；内容不含管理 Token |
| `POST /api/v1/auth/send-code`，请求 `{ "phone": "测试手机号" }` | 成功后返回 `success`、`next_send_in`；模拟模式查日志，真实模式收短信 |
| `POST /api/v1/auth/register` | 请求包含 `phone`、`code`、`nickname`、`invitation_code`；成功返回登录信息 |
| `POST /api/v1/auth/login` | 已注册用户使用 `phone`、`code` 登录 |
| 用户列表与复制 Key | 列表脱敏，授权复制得到完整 Key；普通用户不能访问管理员复制接口 |
| 同一个 `Idempotency-Key` 重试后台充值 API | 只产生一次额度、钱包及充值记录变动；同一键不同内容被拒绝 |
| 同步额度 | 刷新 Sudorouter 剩余额度/已用额度快照，不直接覆盖本地钱包账本余额 |
| 本地/网关余额不足、非法金额、普通用户访问管理接口 | 拒绝操作，不产生成功充值或扣减 |

管理员积分 API 前缀是 `/api/moss/v1/operations`；用户参数使用后台返回的 `legacyId` 数字别名，例如 `/users/{legacyId}/sync-quota`。原生用户 API 使用 UUID，两者不要混用。

本次验证结果：Moss 注册 Node 测试 600 通过、2 跳过；SudoWork Vitest 2566 通过、11 跳过。已实测日志验证码注册、网关控制台登录、模型对话、管理员充值/积分/同步/账本和异常场景。既有类型与测试环境限制记录在各 PR，不能把这些数字理解为真实腾讯云短信或富友支付已经完成生产验收。

## 8. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 登录页没有短信入口 | 检查服务地址和公开配置；设置 `phoneAuth.enabled`、`authMethods` 与 `loginMethod`，重启并重新获取配置 |
| 短信接口提示未开启 | 检查实际进程的 `MOSS_SERVER_CONFIG`、`MOSS_PHONE_AUTH`，不要只改客户端登录页 |
| 已开短信但注册/登录返回 403 | 检查邀请码组织的有效登录策略；按第 5 节配置业务组织 |
| 设置页提示“短信通道未配置” | 当前页面校验旧通道；原生流程使用 `phoneAuth`，见第 5 节的版本限制及初始化方法 |
| 短信发送返回 502 | 检查原生短信凭据、签名审核、模板参数、权限及腾讯云返回错误；不要用旧兼容短信密钥项替代 |
| 发送返回 429 / 验证码过期 | 遵守冷却和限流，获取新码；不要把 6 字符邀请码当作 6 位数字验证码 |
| 邀请码不存在或已使用 | 确认使用真实后台生成且未消费的邀请码，以及目标组织；不能自行编造一个 6 位码 |
| 注册出现网关开户失败 | 核对根地址、`server.sudorouter-api-token`、管理员 ID 与权限；排查后重试登录以恢复缺失的账户配置，不要反复新建同名网关用户 |
| 后台添加账户失败 | 配置 Sudorouter 时账户名要求 1–20 个字符；检查网关开户与密钥创建权限 |
| 能选择模型但提示余额不足 | 检查邀请码是否按默认 0 额度生成；先后台充值再测试对话，默认开户额度不会覆盖邀请码显式设置的 0 |
| 登录成功但模型为空 | 核对用户 Key 已分配、网关用户有模型权限、模型服务商启用且发现地址正确；检查组织是否覆盖了平台模型设置 |
| 默认远程会话返回助手 404 | 确认桌面包含 PR #1156；默认显示名称不应作为真实助手 ID |
| 模型额度足够但会话仍报上下文/输出限制错误 | 检查当前实际运行的 Scode 版本和网关模型元数据，不能只升级 Moss 源码 |
| 点击同步返回 `Sudowork Billing 未配置` | 确认 Moss 包含 `e7532fe` 且 Sudorouter 配置完整；后台额度管理不要求开启富友支付 |
| 改配置后没有变化 | 区分文件、进程环境、平台与组织策略优先级；网关和短信基础设施变更后重启服务 |

持久化时保留 Moss 数据库、Nexus 数据及其密钥材料和运行用户配置。只迁移数据库而丢失 Nexus，会导致用户关系仍在但网关 Key 无法读取。

## 9. 实现依据

- 配置字段与默认值：[types.ts](../src/server/types.ts)、[config.ts](../src/server/config.ts)。
- 原生短信发送与鉴权：[phoneAuth.ts](../src/server/auth/phoneAuth.ts)、[startStandaloneServer.ts](../src/server/startStandaloneServer.ts)、[server.ts](../src/server/server.ts)。
- 组织登录准入：[loginPolicy.ts](../src/server/configuration/loginPolicy.ts)、[auth/service.ts](../src/server/auth/service.ts)。
- 网关地址、凭据与初始额度：[billingRuntimeConfig.ts](../src/server/billing/billingRuntimeConfig.ts)、[sudorouterAdapter.ts](../src/server/billing/sudorouterAdapter.ts)。
- 管理积分与额度同步：[billingService.ts](../src/server/api/compat/sudowork/billingService.ts)、[billingCoordinator.ts](../src/server/billing/billingCoordinator.ts)。
- 旧兼容短信配置校验：[systemConfigService.ts](../src/server/api/compat/sudowork/systemConfigService.ts)。
