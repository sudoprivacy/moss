# Mac MLX 独立服务部署包

`scripts/cabin-model-services.py` 使用 Python 3.8+ 标准库，默认生成 **gateway TTS 8004、stock ASR 8005、缓存 64 的 LLM** 审查包。`prepare`、`dry-run` 和 `--dry-run` 均只写指定的新 output 目录；不连接服务器、不探测端口、不调用 launchctl/Docker、不启动或安装服务。dry-run 会写审查产物，并非完全不写文件。

开发背景、业务配置与总体验收见 [开发方案](cabin_optimization_development_plan_20261124.md)。开发方案的“部署与回退”已链接本文；推荐 app 配置为 [cabin_optimization_20261124.config.json](cabin_optimization_20261124.config.json)。

## 目标 Mac 上的最终 prepare 命令

先把本分支放到目标 Mac 的 `/Users/a1234/Desktop/moss`，确认其中的 `scripts/cabin-model-services.py` 与 `scripts/cabin-tts-server.py` 来自同一交付版本。以下命令在目标 Mac 读取真实 LaunchAgents 和 compose，**不依赖开发机的 /tmp 快照，也不应用部署**：

```sh
python3 -B /Users/a1234/Desktop/moss/scripts/cabin-model-services.py prepare \
  --root /Users/a1234/models-docker-mac \
  --launch-dir /Users/a1234/Library/LaunchAgents \
  --compose-file /Users/a1234/models-docker-mac/docker/docker-compose.yml \
  --compose-target /Users/a1234/models-docker-mac/docker/docker-compose.yml \
  --launch-agent-dir /Users/a1234/Library/LaunchAgents \
  --tts-model /Users/a1234/models-docker-mac/models/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit \
  --output /Users/a1234/cabin-model-services-review-20261124-gateway-v1
```

output 必须尚不存在；如果已经使用过该名字，改用另一个新的绝对目录，不覆盖旧包或备份。默认脚本源就是生成器同目录的 `/Users/a1234/Desktop/moss/scripts/cabin-tts-server.py`，无需额外参数即可使用 gateway。需要选择其他已审查脚本时，可加 `--tts-server-script '/absolute/path/to/cabin-tts-server.py'`；这是**读取并打包的源文件**，不是目标安装路径。源文件缺失/为空就报错，不退回 stock。

生成后先查看 output 中的 `manifest.json`、`DEPLOYMENT.md`，执行只读校验：

```sh
python3 -B /Users/a1234/cabin-model-services-review-20261124-gateway-v1/verify-bundle.py
```

实际安装路径默认是原 audio WorkingDirectory 下的 `cabin-tts-server.<源码SHA256前12位>.py`，完整绝对路径写入 manifest、TTS plist 和 DEPLOYMENT.md。它与 Desktop 中的源文件分离；也可以用 `--tts-script-target '/absolute/new/path/cabin-tts-server.py'` 显式指定。安装时拒绝覆盖任何现有文件或符号链接，目标父目录必须存在。

## 参数和路径

- `--root`：源部署根目录，默认 `~/models-docker-mac`；读取模型证据，不重写原 LLM 的路径。
- `--launch-dir`：默认 ROOT/launch；生产上应像上面的命令一样明确使用真实 LaunchAgents 目录。
- `--compose-file`：显式输入最清晰；省略时从 ROOT/docker/docker-compose.yml、ROOT/deploy/docker-compose.yml、ROOT/deploy/docker-compose.yaml 中选唯一存在的文件。
- `--compose-target`：手动命令使用的生产 compose 绝对路径；默认原 audio WorkingDirectory/docker/docker-compose.yml，独立于本地快照路径。
- `--launch-agent-dir`：目标安装目录；省略时由目标 Mac 的 `$HOME/Library/LaunchAgents` 展开。
- `--tts-server-script`：可选源脚本，默认生成器同目录的 cabin-tts-server.py；不导入、执行或修改脚本。
- `--tts-script-target`：目标 Mac 上新增的绝对脚本路径；默认包含源码哈希，不复用 Desktop 中的源脚本。
- `--tts-model`：实际 TTS 模型绝对路径。省略时仅在 compose 的 AUDIO_TTS_MODEL/DEFAULT_MODELS、原 LLM --model 和 ROOT/models 下 qwen3_tts config.json 能相互印证时解析 MODEL_HOME；不一致则要求显式指定，不猜模型名称或模型根目录。
- `--asr-label`：默认 com.comac.mlx-asr；不能与原 Label 相同或在输入 launch-dir 已存在。实际目标机是否已有同名服务仍要部署前检查。
- `--output`：新目录，父目录已存在，不允许符号链接、已有目录，或位于输入 launch/compose 目录内。除 output 及其子项外主工具不写其他文件；目录 0700、文件 0600。

所有路径支持空格和单引号，生成命令使用 POSIX shell 引用。生成器、打包脚本和模型路径分别校验，不将快照路径当成生产安装路径。

## 配置变更边界

LLM 保留原 com.comac.mlx-lm Label、模型、路径、端口、环境、日志、未知字段及所有其他参数，只把 --prompt-cache-size 设置为显式 64。支持独立值与 `--prompt-cache-size=10` 写法，重复/缺值拒绝生成。缓存 64 是条目数，不是会话数、内存硬上限或缓存命中保证；LLM 重启丢失内存缓存。

TTS 保留原 com.comac.mlx-audio Label、8004、全部环境、日志和未知用户配置。ProgramArguments 替换为：

```text
/原audio所在venv/bin/python /明确的已安装gateway绝对路径 --model 实际TTS模型绝对路径 --host 0.0.0.0 --port 8004
```

Python 取原 audio 可执行文件同一 bin 目录的 python，不 resolve Python 的符号链接，以免脱离 venv；无法识别 bin 目录就报错。若原 plist 还含 Program，必须同时改为该 Python，因为 launchd 的 Program 优先于 argv[0]。原生 CLI 参数只保存在完整备份和 stock ASR 中，不传给接口不同的 gateway。不新增 batch 环境变量；已有环境变量原样保留。

独立 ASR 从原始 audio 深拷贝，仅改变 Label、端口为 8005、stdout/stderr 独立日志文件，继续使用原 stock 可执行文件、参数、工作目录和环境。原 audio 必须显式为 8004；LLM 端口必须有效且不冲突。带 launchd Sockets/MachServices/inetdCompatibility 的 audio 配置需要额外资源隔离，工具拒绝派生。新日志父目录须已存在且可写。

ASR proxy 的服务名从输入 compose 中唯一明确的 `UPSTREAM_URL: http://host.docker.internal:8004` 识别；给定快照实际为 asr-proxy。只生成该服务指向 `http://host.docker.internal:8005` 的覆盖片段，BASE 不改写，TTS 路由仍为 8004。无匹配或多个候选均报错，不猜服务名。仓库 deploy/docker-compose.yml 没有此代理，不能代替模型部署 compose。

使用标准库的保守 block-style services/environment 识别器，支持环境映射和列表、简单引用；遇到 include、anchor/alias/merge、extends、env_file、内联或嵌套 environment、插值上游等结构会拒绝。模型字段仅支持明确的字面量或可验证的 MODEL_HOME 引用。这不是完整 YAML 校验器，手动应用前必须使用现场原有参数运行 `docker compose ... config`。

## 产物、校验与手动应用

| 产物 | 用途 |
| --- | --- |
| backup/*.plist、backup/docker-compose.yml | 输入原始字节备份；包括完整旧 stock TTS，用于审查 |
| prepared/com.comac.mlx-lm.plist | 原 LLM，只设置缓存 64 |
| prepared/com.comac.mlx-audio.plist | 原 Label/8004 的 gateway TTS 候选 |
| prepared/com.comac.mlx-asr.plist | stock ASR 8005，Label 可自定义 |
| payload/cabin-tts-server.py | gateway 源码字节副本，不依赖原源码位置 |
| manifest.json、verify-bundle.py | 源码/产物 SHA-256；可复制包后重新校验，校验本身不安装 |
| gateway-file.py | 显式调用才复制/检查/移除单个脚本文件，不管理服务 |
| compose.asr-8005.override.yml、compose.rollback.override.yml | 切换实际代理到 8005 / 恢复 8004 |
| DEPLOYMENT.md | 按实际输入生成的路径、端口检查、备份和应用/回退命令 |

按 DEPLOYMENT.md 逐段操作，以 LaunchAgent 所属用户的图形登录会话执行，不用 sudo。复制整个包到另一台机器时修改 BUNDLE；manifest 中目标路径须仍适用，否则重新 prepare。SHA-256 是内容完整性校验，不是来源签名；仍需审查源代码和配置。

应用顺序：停止业务流量 → verify-bundle → cmp 确认输入快照仍与现场一致 → 检查 Label、模型/可执行文件/日志目录、8004 归属和 8005 IPv4/IPv6 bind → plutil 与 compose config → 新建 live-backup 保存现场文件及有效 compose → 显式安装 gateway 文件 → 替换/bootstrap LLM 和 TTS → bootstrap stock ASR → 真实推理验收 → 用 override 重建单个 proxy。工具不执行任何一步。

保留现场 Compose 项目名及原有 -f、--env-file、profiles 等全部参数，并把本次 override 放在最后；之后每次重建都要带它。live-backup 是部署时的回退依据，backup 是 prepare 输入快照，不能混淆。现场文件与输入不同就停止、重新收集并 prepare。端口检查只代表检查时刻，不保证随后没有竞争；PID、bootstrap 成功和 /v1/models 都不等于真实推理成功。

## 必须先 gateway，再合并 app 设置

先部署并验收 gateway，之后才部署配套 Moss、备份原 app 配置并按字段合并 [推荐片段](cabin_optimization_20261124.config.json)。不能用该片段替换整个生产配置；保留原 URL、模型绝对路径、凭据和其他业务设置。本工具不读写 app 配置，也不重启 Moss。

当前推荐 cabin.ttsGeneration 配置 topP=1、topK=50、repetitionPenalty=1.05、seed=42、maxTokens=1024，并设置 cabin.ttsDeterministicRequired=true。**设置 `cabin.ttsGeneration.temperature=0.9`，覆盖旧的零温度配置**。14:02 的生产个性化问候在中文 temperature=0 时生成了67.92秒不可识别音频，固定seed采样0.9则恢复4.64秒完整语音；因此中文也使用采样，不再使用零温度默认值。HTTP 请求对应 max_tokens=1024。日语使用 ono_anna/Japanese，韩语使用 sohee/Korean，其余片段所列语言使用 Vivian 及各自语言。

真实合成响应必须包含 `x-cabin-tts-deterministic: seeded-serial-v1` 与 `x-cabin-tts-seed: 42`。stock HTTP schema 会忽略 seed，不能因为请求含 seed 就认为生效；stock 缺少能力确认头，新 app guard 会拒绝，因此不能在 gateway 验收前先合并严格配置。

同一句零温度串行约 4.24s、进入 continuous batch 约 3.68s 且哈希不同，说明批量数影响结果。日语 Vivian 零温度曾重复约 48s；日语 ono_anna、韩语 sohee 也出现约 24s 耗尽 300 token、丢后文/退化且 ASR 仅识别问候。零温度不是通用修复。gateway 方案使用串行生成和实际重置 seed；固定模型、MLX/backend 和参数后仍要逐语言检验全文完整性、时长、串行/并发摘要及听辨，不把参数或能力头本身当成质量证明。

独立 ASR 与 gateway 仍共享 GPU、统一内存和带宽，不保证整体加速；需多座位 P95、错误率、冷启动和内存压力对照，不能用空闲内存或进程拆分替代性能证据。

## 回退及新增文件所有权

若已启用严格 app 配置，先停止流量并恢复备份的 app 原配置/旧版本；否则切回 stock 后会被 guard 拒绝。再按 DEPLOYMENT.md 从 live-backup 恢复完整原 TTS plist，启动并验收原 8004，代理回到 8004，停止并删除本次 ASR plist，恢复原 LLM plist。现有 TTS/LLM 文件必须仍是本包候选或原始备份；发现他人修改就停止协调。

gateway-file.py 安装使用独占创建，拒绝覆盖已有文件或符号链接；创建记录保存在本包 live-backup/gateway-created.json。移除时验证目标绝对路径、SHA-256、设备号及 inode，只删除本次创建且仍未被修改/替换的脚本。没有记录不删除；相同内容但不同 inode、改成符号链接或内容变化均拒绝删除。复制中断且尚未完成创建记录的残留文件须人工核对，不擅自认领。回退保留日志、备份和创建记录，不覆盖原 BASE 或他人改动。

## 本地单元测试

```sh
python3 -B -m unittest discover -s scripts/__tests__ -p 'test_cabin_model_services.py' -v
```

测试使用临时合成 gateway/模型证据、plist 和 compose，不依赖真实 gateway 文件、MLX 或 Docker。覆盖默认 gateway、CLI 和空格/单引号路径、LLM/ASR 变更边界、原环境/日志/未知项保留、完整备份、模型证据不足时拒绝、打包哈希、独占文件复制和回退所有权保护。文件复制测试只操作临时惰性文本，绝不运行 gateway 或管理真实服务。-B 避免仓库生成 __pycache__。
