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

```bash
openssl genrsa -out msgaudit_v1_private.pem 2048
openssl rsa -in msgaudit_v1_private.pem -pubout -out msgaudit_v1_public.pem
```

公钥全文（含 `-----BEGIN/END PUBLIC KEY-----`）贴进企微后台；私钥填进 moss。

**私钥丢失 = 历史记录永久无法解密**，企微没有副本。

### 密钥轮换

企微给每个上传的公钥分配 `publickey_ver`（从 1 递增），每条记录都带着它。轮换后**旧记录仍用旧版本加密**，所以旧私钥永远不能删。moss 的 `privateKeys` 字段因此支持版本映射：

```json
{"1": "-----BEGIN RSA PRIVATE KEY-----\n...", "2": "-----BEGIN RSA PRIVATE KEY-----\n..."}
```

只有一个版本时直接粘贴 PEM 即可（视为版本 1）。

## 五、配置步骤

1. 管理后台 → 企业应用 → 新建 → 类型「企微会话存档」
2. 填 CorpID + 事件回调 Token/EncodingAESKey（**存档侧生成的**，不是应用的）
3. 复制列表中的回调 URL，填入企微后台完成 URL 验证
4. 填会话存档 Secret + RSA 私钥 → 拉取自动开始（每 5 分钟一轮）

只填 2 不填 4 是合法状态：仅提供回调端点、不拉取。

## 六、SDK 依赖

`GetChatData`/`DecryptData` **在 qyapi 上不存在**，只存在于企微发布的原生 C 库 `libWeWorkFinanceSdk_C.so`，官方仅提供 **linux/amd64**。

- 该库**不在仓库中**，需自行从企微后台下载，放到 `deploy/wework-finance-sdk/`
- 缺失时镜像照常构建，只是拉取不可用
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

## 八、幂等与游标

- 记录**先落盘、后推进游标**。中间崩溃会重放窗口，由 msgid 去重吸收；反过来则会永久丢消息（存档有保留期，事后无法补拉）
- `cursor.json` 用临时文件 + rename 原子写：游标写坏会导致全量重放或永久跳过
- 解密失败的记录（通常是私钥版本缺失）**计数并跳过**，游标照常前进 —— 否则整个存档会永久卡在那条记录后面

## 九、尚未实现

- **媒体文件**：图片/语音/文件的二进制需 `GetMediaData` 单独拉取，当前只存元数据
- **明文加密存储**：解密后的聊天内容以明文 JSONL 落盘。是否静态加密、保留多久，取决于你的合规要求
## 十、FFI 绑定验证状态

`sdk.ts` 的函数签名已在 **linux/amd64（CentOS 7, glibc 2.17）** 上、于实际部署镜像
`my-moss-server` 内验证通过：

- koffi 2.16.3 安装并加载 `.so` 正常
- 五个签名全部绑定成功：`NewSdk` / `Init` / `GetChatData` / `DecryptData` / `DestroySdk`，
  含 Slice_t out-pointer 的分配、内容读回与释放
- 全链路跑通：SDK 取页 → 真实 RSA 私钥解出对称密钥 → 规范化 → JSONL 落盘 → rooms.json
- 错误路径：`errcode` 非 0 抛出、`Init` 失败守卫、解密失败计数跳过且游标继续前进

验证使用 gcc 编译的同签名替身库（企微 SDK 需登录后台下载，服务器上没有）。
**与真实 SDK 的剩余风险**：函数签名若与实际头文件不符（参数个数/类型），
会在首次调用时报错而非静默出错 —— 替换真库后跑一次拉取即可确认。
