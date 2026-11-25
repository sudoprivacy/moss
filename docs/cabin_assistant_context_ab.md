# Cabin 助手上下文对照测试

## 短规则候选版

在 `986b7650` 上增加了 `assistant-short`。同一候选镜像可对比 `compact`（默认）、`assistant-context`（完整正文）和 `assistant-short`（审过的短规则）。在隔离容器的 `server.json` 中合并以下字段，保留原有模型、音色和业务配置。

```json
{"cabin":{"dialogueMode":"assistant-short","conversationLanguageMode":"enabled","shortRulesPrewarm":true}}
```

启用短规则时，主 HTTP 端口在助手及已启用技能通过校验后开放。`shortRulesPrewarm` 默认关闭。开启后，在监听前用合成上下文调用一次同一模型，仅准备提示前缀。启动日志中的 `PREWARM` 和 `usage` 可用于排查模型超时与缓存命中。回退时设 `dialogueMode` 为 `compact` 并重启测试容器。

助手配置 `ruleFile` 和每个启用技能的 `SKILL.md` 是规则来源。对应目录的 `CABIN_RULES.md` 第一行为 `source-sha256: <摘要>`，其余正文是人工核对过的乘客服务规则。发布时对照源文件复核短规则，再用以下命令计算首行摘要。四份短规则合计上限 6 KiB。安装目录中的短规则优先。缺少短规则时会尝试工作目录中的发行版副本，校验同一个源摘要。原文件缺失或摘要不符时，启动校验会报出路径。对现场缺失的 `cabin-hardware-control/SKILL.md`，先从匹配版本的备份或镜像恢复到测试副本。保留管理员已编辑的源文件。

```sh
bun -e 'const source = (await Bun.file(process.argv[1]).text()).trim(); console.log(new Bun.CryptoHasher("sha256").update(source).digest("hex"))' "$SOURCE_FILE"
CABIN_SMOKE_DIALOGUE_MODE=assistant-short CABIN_SMOKE_PREWARM=1 bun scripts/cabin-live-smoke.ts > assistant-short.json
```

3B 验收使用同一座位和会话连续测试“想眯一会儿 → 需要”和“坐久了腰背有点僵 → 不用了，先保持这样”。检查模拟接口日志，预期只收到一条放倒指令，按摩拒绝轮设备和订单调用均为零。“取消可乐订单”则应访问订单接口。分开记录首文字、语音准备完成、UE 实际起播。冷态由模型返回的 `cached_tokens` 判定，共用模型时重启容器仍可能命中上组的缓存。

## 完整规则对照

基线为 `codex/cabin-status-mode-tools` 的 `d848f4ba`。在同一候选镜像中，修改现有 `server.json` 的 `cabin.dialogueMode` 并重启应用。A 组选 `compact`，B 组选 `assistant-context`。回退到旧镜像前先恢复 `compact`，旧配置校验器仅识别 `compact` 和 `agent`。

B 组使用 `cabin.assistantName` 对应的已安装助手正文、元数据 `enabledSkills` 中各技能的 `SKILL.md`，以及当前请求的称呼、座位、航班、偏好语言和本轮回复语言。可在应用运行期间更新规则，应用侧缓存窗口为 5 秒。模型复用前缀的实际效果需从模型 usage 和实测时延判断。规则读失败会使对应模型请求报错。静态正文上限 96 KiB，近期历史沿用 `dialogueHistoryMaxBytes`。

问候、明确的设备请求和订单继续使用原生业务路由。这些快路径沿用既有业务配置。已安装技能列表控制模型可见的原生工具。实验版可登记座椅放倒、加热、通风和按摩建议，需启用现有的逐轮语言模式 `cabin.conversationLanguageMode = "enabled"`，并使用受支持的语音语言。登记成功后乘客可以确认、拒绝或修改建议。设备、查询和模式工具继续校验本轮指令和座位绑定。

## 运行隔离对照

在装有 Bun、项目依赖、同一套已安装助手与技能的环境执行。按实际接入设置 `MOSS_HOME`、`CABIN_SMOKE_LLM_URL`、`CABIN_SMOKE_LLM_MODEL`、`CABIN_SMOKE_TTS_URL`、`CABIN_SMOKE_TTS_MODEL`。模型 URL 使用本机端口或 SSH 转发，TTS 使用与应用相同的确定性网关。自定义助手可设置 `CABIN_ASSISTANT_NAME`。

```sh
CABIN_SMOKE_DIALOGUE_MODE=compact bun scripts/cabin-live-smoke.ts > compact.json
CABIN_SMOKE_DIALOGUE_MODE=assistant-context bun scripts/cabin-live-smoke.ts > assistant-context.json
```

两次使用相同的模拟乘客、上下文、设备和上传端点。比较每轮 `first_delta_ms`、`done_ms`、`reply` 以及 `mock_device_calls`。语义回归包含询问称呼、暗示想休息、下一轮确认。候选组确认前下发次数应为 0，确认轮为 1。实验接入失败时脚本退出并打印出错轮次。应用出站日志中的 `rule_hash`、`enabled_skills`、`request_bytes` 和模型返回的 `usage` 可用于核查实际输入。

单次运行提供功能样本。评估现场速度时按冷启动、预热后和多座位交替分组，交换 A/B 运行顺序。另从客户端记录说完话到开始播放的时间，比较中位数和 P95。
