# Cabin 助手上下文对照测试

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
