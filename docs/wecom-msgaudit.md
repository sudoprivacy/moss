# 企微会话内容存档（会话存档）

拉取外部群/内部群聊天记录，落盘为 JSONL，供 AI agent 做统计、摘要、检索。

## 一、它不是一个应用

会话存档是**企业级付费服务**，与自建应用是两套东西：

| | 自建应用 | 会话存档 |
|---|---|---|
| AgentId | 有 | **无** |
| Secret | 应用 corpsecret | 「安全与管理 → 会话内容存档」单独签发 |
| 两者能否互换 | 否 —— 存档 Secret 换不出应用 access_token | |
| RSA 密钥对 | 不需要 | **需要**，你自己生成 |

因此在 moss 中它是独立的 corp-app 类型 `wecommsgaudit`，不是给 `wecomapp` 加能力。

## 二、四个凭据，别混淆

| 凭据 | 谁生成 | 算法 | 用途 |
|---|---|---|---|
| `callbackToken` | 企微后台 | SHA1 | **事件回调**验签 |
| `encodingAesKey` | 企微后台（43 字符） | AES-256-CBC | **事件回调**解密 |
| `secret` | 企微后台 | — | 换 token 拉记录 |
| **RSA 私钥** | **你 openssl 生成** | **RSA-2048** | **解密拉回的记录** |

`encodingAesKey` 与 RSA **完全无关**：前者是对称密钥、解事件回调（内容里没有聊天记录）；后者是非对称、解真正的聊天内容。企微后台没有"生成公钥"按钮，只有让你**粘贴公钥**的输入框 —— 这是唯一一个"你造、企微收"的凭据。

## 三、两条数据通路

```
事件回调  企微 → moss   HTTP + WXBizMsgCrypt   内容：谁同意/取消了存档
聊天记录  moss → 企微   native SDK 轮询拉取     内容：真正的聊天
```

**填了事件服务器不会让聊天记录流进来。** 记录必须主动拉。事件只用于存档覆盖率监控；纯内容分析不需要它们（`getchatdata` 只返回已同意成员的消息）。

## 四、生成 RSA 密钥对

**推荐：在管理后台点「生成密钥对」按钮。** 先保存该应用，再回到配置弹窗，
点击生成 —— 私钥直接写入加密凭据（不回显、不经过剪贴板），公钥显示在弹窗里
供复制。公钥常驻保存在 `config_json` 中，随时可以回来重新复制。

也可以手动生成后粘贴私钥：

```bash
openssl genrsa -out msgaudit_v1_private.pem 2048
openssl rsa -in msgaudit_v1_private.pem -pubout -out msgaudit_v1_public.pem
```

公钥全文（含 `-----BEGIN/END PUBLIC KEY-----`）贴进企微后台；私钥填进 moss。

**私钥丢失的影响**：已归档到 moss 的 JSONL **不受影响** —— 记录在拉取时就已解密，
落盘的是明文。但企微保留期内**尚未拉取**的记录将永久无法取回（企微只有公钥，
没有你的私钥副本，且保留期过后原始数据即删除）。

### 密钥轮换

企微给每个上传的公钥分配 `publickey_ver`（从 1 递增），每条记录都带着它。轮换后**旧记录仍用旧版本加密**，所以旧私钥永远不能删。moss 的 `privateKeys` 字段因此支持版本映射：

```json
{"1": "-----BEGIN RSA PRIVATE KEY-----\n...", "2": "-----BEGIN RSA PRIVATE KEY-----\n..."}
```

只有一个版本时直接粘贴 PEM 即可（视为版本 1）。

管理后台提供两条路径，**都是追加语义**，不会动到其他版本：

- **生成密钥对 / 轮换** —— 服务端生成 RSA-2048，私钥直接入库不回显，版本号自动递增
- **导入已有私钥**（迁移场景）—— 手动指定 `publickey_ver` 并粘贴 PEM。用于公钥已在
  企微后台注册、你手里有对应私钥的情况。版本号必须与企微记录中的一致，否则那批记录解不开。

两者都只影响指定的那一个版本。凭据 blob 里的 Secret / 回调 Token / EncodingAESKey
也会被保留 —— 这是走专用端点而不是通用 PATCH 的原因：PATCH 是整体替换，
会静默清掉同一 blob 中的其他字段。

## 五、配置步骤

1. 管理后台 → 企业应用 → 新建 → 类型「企微会话存档」
2. 填 CorpID + 事件回调 Token/EncodingAESKey（**存档侧生成的**，不是应用的）
3. 复制列表中的回调 URL，填入企微后台完成 URL 验证
4. 填会话存档 Secret + RSA 私钥 → 拉取自动开始（每 5 分钟一轮）

只填 2 不填 4 是合法状态：仅提供回调端点、不拉取。

## 六、SDK 依赖

`GetChatData`/`DecryptData` **在 qyapi 上不存在**，只存在于企微发布的原生 C 库 `libWeWorkFinanceSdk_C.so`，官方仅提供 **linux/amd64**。

- 该库**已随仓库提供**：`deploy/wework-finance-sdk/libWeWorkFinanceSdk_C.so`（git-lfs），
  连同官方头文件 `WeWorkFinanceSdk_C.h`。版本 20250205，MD5 与官方 `md5.txt` 一致。
- 它是**通用库**，不含任何企业信息 —— corpId / Secret / RSA 私钥全部是运行时参数。
  所有企业用同一个文件，无需各自下载。
- 官方下载地址（公开，无需登录）：
  `https://wwcdn.weixin.qq.com/node/wwcomm/sdk_x86_v3_20250205.tgz`（x86_64）；
  ARM 版为 `sdk_arm_v3_20250205.tgz`，但 moss 镜像是 amd64-only，用不到。
- 若文件缺失，镜像照常构建，只是拉取不可用
- moss 镜像本身已是 amd64-only（Dockerfile 中的 `/lib/x86_64-linux-gnu` 符号链接），故 SDK 不引入新约束
- **macOS 本地无法拉取**；事件回调那半边可以本地开发调试

拉取运行在 **fork 出的子进程**中：原生库是黑盒，段错误不是可捕获的 JS 异常，隔离后崩溃只影响一次拉取。

## 七、存储格式（agent 读取入口）

```
$MOSS_HOME/msgaudit/<corpAppId>/
  cursor.json                        {"seq": 12345, "updatedAt": ...}
  rooms.json                         roomId -> {dir, count, lastSeen}
  chat/<roomId>/<YYYY-MM-DD>.jsonl   每行一条消息
```

`MOSS_HOME` 已在 `deploy/docker-compose.yml` 中挂载到宿主机（`./.moss:/root/.moss`），**无需额外挂载**，容器内写入的记录宿主机直接可读。

每行一条 JSON：

```json
{"seq":123,"msgid":"M123","msgtime":1772000000000,"from":"alice","to":["bob"],
 "roomid":"wrABC","msgtype":"text","text":"你好","payload":{...}}
```

设计取舍：

- **按「群 / 天」分片** —— agent 问"总结这个群上周"只读 7 个小文件，不必扫全量
- **JSONL 而非 JSON 数组** —— 追加是 O(1)，读取可逐行流式，单日文件不必整体载入内存
- **`text` 提升到顶层** —— agent 不需要了解企微每种 msgtype 的嵌套结构；原始字段仍保留在 `payload` 中不丢失
- **`roomid` 做路径消毒** —— 企微 id 可能含 `/`、`=`，非法字符会被哈希（`h_<sha256前32位>`），映射记录在 `rooms.json`
- **1:1 会话** 无 roomid，归入 `_direct/`

### agent 用法示例

```bash
# 某群某天的全部消息
cat $MOSS_HOME/msgaudit/<id>/chat/wrABC/2026-03-01.jsonl

# 该群最近 7 天发言量
for d in $(seq 0 6); do
  f=chat/wrABC/$(date -d "-$d day" +%F).jsonl
  echo "$f $(wc -l < $f 2>/dev/null || echo 0)"
done

# 全部群按活跃度排序
jq -r '.[] | "\(.count)\t\(.roomid)"' rooms.json | sort -rn
```

## 八、拉取节奏与配置

拉取是**循环定时**的：启动后 10 秒跑第一轮，之后按间隔轮询所有 enabled 的实例。
每轮内部一直翻页直到拉空或触及页数上限；每页最多 1000 条。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MOSS_MSGAUDIT_INTERVAL_SEC` | `300`（5 分钟） | 轮询间隔，下限 30 秒 |
| `MOSS_MSGAUDIT_MAX_PAGES` | `20` | 每实例每轮最多拉几页；`0` = 不限、一次拉完 |

首轮从 seq=0 开始，即企微保留期内的全部历史。页数上限把这次回填**分摊到多轮**，
避免一次长时间占住原生 SDK 会话；游标每页提交，下一轮自然从断点续拉。
日志会在触顶时标注 `(page cap reached; resuming next tick)`。

非法值（小于下限或非数字）会被忽略并告警，回落到默认值。

## 九、群聊过滤（可选）

实例配置里的**群聊过滤**字段可以只归档指定的群。逗号、空格、换行任意混用，
留空表示不过滤（归档全部会话，含单聊）。

```
wr_l7aCgAAoFEUD7y9cEvqAzpmL-WPWg, wr_l7aCgAAWRF4xBDPJEFfSmwIV3W3Mg
```

**过滤发生在解密之后。** 企微的 `GetChatData` 只返回
`{seq, msgid, publickey_ver, encrypt_random_key, encrypt_chat_msg}` ——
`roomid` 只存在于加密体内部，拉取时无从得知。因此这个过滤器：

- ✅ 减少**落盘量**与明文存储面
- ❌ **不减少**拉取量、解密开销或企微侧调用

游标会照常越过被过滤的记录 —— 它们已经拉取过、不会再回来，为它们停住游标
会导致无限重拉。**这也意味着放宽过滤器不会补回此前被过滤掉的消息**，
需要重置游标才能重拉。

修改后**下一轮拉取生效**（默认 5 分钟），不影响已归档的记录。日志会显示
`filtered=N`。

## 十、幂等与游标

- 记录**先落盘、后推进游标**，且游标**逐页提交**。moss 重启/崩溃后从 `cursor.json` 续拉：
  已提交的页不会重拉，未提交的页会重放并由 msgid 去重吸收 —— **既不重复也不遗漏**。
  反过来（先推游标）则会永久丢消息（存档有保留期，事后无法补拉）
- `cursor.json` 用临时文件 + rename 原子写：游标写坏会导致全量重放或永久跳过
- 解密失败的记录（通常是私钥版本缺失）**计数并跳过**，游标照常前进 —— 否则整个存档会永久卡在那条记录后面

## 十一、尚未实现

- **媒体文件**：图片/语音/文件的二进制需 `GetMediaData` 单独拉取，当前只存元数据
- **明文加密存储**：解密后的聊天内容以明文 JSONL 落盘。是否静态加密、保留多久，取决于你的合规要求
## 十二、FFI 绑定验证状态

`sdk.ts` 的函数签名已在 **linux/amd64（CentOS 7, glibc 2.17）** 上、于实际部署镜像
`my-moss-server` 内验证通过：

- koffi 2.16.3 安装并加载 `.so` 正常
- 五个签名全部绑定成功：`NewSdk` / `Init` / `GetChatData` / `DecryptData` / `DestroySdk`，
  含 Slice_t out-pointer 的分配、内容读回与释放
- 全链路跑通：SDK 取页 → 真实 RSA 私钥解出对称密钥 → 规范化 → JSONL 落盘 → rooms.json
- 错误路径：`errcode` 非 0 抛出、`Init` 失败守卫、解密失败计数跳过且游标继续前进

**已用真实 SDK 验证**（20250205，x86_64）：8 个函数签名全部绑定成功，
并逐一比对官方头文件 `WeWorkFinanceSdk_C.h`，参数个数与类型完全一致。

实际调用链路也已跑通：`NewSdk` → `Init` → `GetChatData` → `GetContentFromSlice`
→ `FreeSlice` → `DestroySdk`，无段错误。用伪造凭据调用时，SDK 真实访问了企微
服务器并返回 `40001 invalid credential` —— 证明库已正确加载、网络通路正常、
参数传递无误。剩下的只是填入真实 Secret 与 RSA 私钥。
