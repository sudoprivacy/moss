# Cabin 延迟与语音稳定性开发方案（最终实现）

## 根因与范围

2026-11-24 现场首句“你好”恢复了旧 Agent transcript：21,109 个输入 token，缓存命中为零，预填充约 8.528 秒，首文字 9.345 秒，TTS 约 2.092 秒。Mac M3 Ultra / 512GiB 的空闲内存约 431GiB，无交换/压缩压力；增加容器内存无法解决这次计算开销。`contextReplayTurns` 只限制恢复时重放，不能限制已恢复的 scode transcript。

TTS 原生 HTTP 接口没有 seed 字段，且默认可批量生成。同文零温度在串行与双请求批内的结果也不同；日、韩零温度出现循环/截断（24–48 秒）。因此撤销第一阶段将零温度作为通用修复的建议。本方案同时修改业务推理、TTS 服务和 ASR 调度；仅更新 Moss 或仅改 temperature 均不是完整部署。

## 已实现

| 问题 | 实现 | 边界 |
|---|---|---|
| 纯问候仍预填充大量历史 | 当前语言整句问候白名单，跳过 LLM，沿用 SSE/历史/独立座位上传 | 问候加需求不截断；开关 `greetingFastPathEnabled` |
| 后续问答仍恢复庞大 Agent | 默认 `dialogueMode=compact`，专用 OpenAI 原生请求，仅三类 Cabin 工具；完整请求 12288 字节，历史默认 4096 字节 | 不再创建通用 scode 会话；`agent` 保留回退；长当前输入明确拒绝，不静默截断 |
| 模型可能编造硬件执行 | 参数枚举/范围、当前轮意图、座位绑定经服务端校验，调用既有控制/模式/状态实现 | 状态从真实接口读取；否定/条件/历史不能授权操作；无工具回复不套用假执行回执 |
| 语音随机性与批量变化 | 新 `scripts/cabin-tts-server.py` 单模型、单工作线程、每次重置 seed、串行生成，固定 seed 采样（各已验语言 temperature=0.9；生产中文零温度退化后修正） | 模型/MLX/backend 固定条件下复现；声纹跨文本和 UE 听辨仍需验收；吞吐换取可复现性 |
| 日、韩贪心重复 | 恢复正温度，固定种子；推荐 Japanese/ono_anna、Korean/sohee，其余已验语言 Vivian | 配置显式选择，不擅自覆盖现场定制音色 |
| 坏音频仍可能被上传 | gateway 拒绝 token 上限耗尽、空/非有限/异常时长音频；Moss 校验 PCM WAV 与确定性能力标志 | 失败不缓存、不上传坏文件；不以“哈希相同”代替内容质量检查 |
| ASR 被 TTS 排队 | 独立 ASR 8005，原 8002 proxy 指向 8005；TTS 8004 仅负责合成 | 共享 GPU，需多座位压力验收；不提高系统 wired memory |
| 重复固定回执合成 | 有界内存 LRU 64条/16MiB/30分钟，合并同时请求 | 只复用公开固定音频，每次控制与座位上传仍执行；动态/含乘客称呼回复绕过共享缓存 |
| 音频链路缺证据 | 合成、缓存、上传前记录 SHA-256 和采样率/位宽/声道/时长 | 原样上传；历史 TTS/UE 无摘要，不能追认历史链路一致 |
| 上游读取无界等待 | compact、TTS、ASR 的 deadline 包含响应正文；TTS 服务队列有界 | 不靠无限重试掩盖失败 |

自动航段广播也接入同一 TTS 参数、deadline、能力检查和音频摘要。其磁盘缓存键加入端点、采样参数和能力要求，避免继续命中旧随机合成文件；需要时显式更新 `broadcastTtsVersion`。

## 部署与回退

完整步骤见 [cabin_model_services_deployment.md](cabin_model_services_deployment.md)。模型服务准备工具只生成备份、候选 plist、Compose override、应用/回退脚本，不自动部署。工具在目标服务器读取真实 LaunchAgents/Compose，避免把本机 `/tmp` 当作服务器生产路径。新 TTS gateway 使用现有 venv/权重，独立 ASR 使用现有 stock `mlx_audio.server`，LLM 仅将 prompt cache 条数 10→64；不更换模型权重、不增加无依据内存配额。

顺序：准备审查包 → 应用模型服务方案 → 真推理确认 gateway 与 ASR 正常 → 部署本分支 Moss → 合并 [配置片段](cabin_optimization_20261124.config.json) 并重启 Moss。片段只合并 `cabin` 内列出的字段，保留现场的 URL、模型绝对路径、凭证和其他业务配置；不要替换整个 server 配置；将 `cabin.ttsGeneration.temperature` 明确设为0.9，覆盖旧的零温度设置。`ttsDeterministicRequired=true` 会检查上游能力和实际 seed，旧 stock 服务不会被误认为已生效。

回退使用部署包现场备份恢复原模型服务与代理；Moss 切回旧版本/原配置。单独回退到原 audio 时须同步关闭 `ttsDeterministicRequired`，否则新应用按设计拒绝不支持 seed 的服务。`dialogueMode=agent` 恢复旧推理路径，可能重新出现长上下文预填充；关闭问候/缓存也只是回退而非性能方案。

## 验证与验收

自动回归覆盖既有 Cabin 路由、多语言、座位隔离、状态/模式、真实下发结果、恢复兼容、缓存和二进制上传。新增 Python 测试覆盖 gateway 串行/种子/队列/超时/坏音频与部署备份/回退生成。真实模型隔离验证在生产主机临时端口运行，未修改现有生产服务；结果见 [验证报告](cabin_optimization_validation_20261124.md)。

`scripts/cabin-live-smoke.ts` 在本地启动实际 Cabin API，LLM/TTS 经 localhost SSH 转发访问服务器，其余上下文/设备/广播全部终止于本地 mock。它验证首 delta、完整音频链路、缓存摘要、状态/模式和不创建 Agent；不会给真实座椅或 UE 下发消息。

生产验收需要测冷/热首文字、首起播和多座位 P95，逐语言听辨漏字、循环、截断及音色；在存储端、UE 解码前与播放配置中补采 SHA-256/采样率/声道/播放倍速。源端测试通过不能证明 UE 的历史音高问题已消失。用户完成部署后的实际 UE 播放验收是最终闭环。
