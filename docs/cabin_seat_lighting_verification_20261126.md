# 3B 座位模式和氛围灯对话验证记录

2026-11-26，分支 `codex/cabin-assistant-context`，基线 `8b71ca31`，配置 `assistant-short`。现场型号为 Qwen3.6-35B-A3B-4bit，网关返回的 100 个模型 ID 中没有 Qwen。使用 `deepseek-v3.2` 验证中文理解和工具选择。另一候选 `Llama-4-Maverick-17B-128E-Instruct-FP8` 普通请求可达，在使用应用工具请求的六个对话测试中均返回 HTTP 400，设备写入为零。

## 环境与结果

使用合成乘客、航班 SIM、飞机 B-SMOKE、座位 3B。客舱 API、临时 SQLite、Assistant、三个 Skill 均走应用代码。乘客资料、广播、灯控、语音识别由本机 HTTP 服务模拟。模型走真实网关。语音重传使用同一 `Idempotency-Key`，两次提交分别经过识别，设备请求共一次。应用在同一绑定和会话内保留请求键五分钟。

| 测试 | 结果 |
|---|---|
| 模拟模型和业务接口 | 59/59 |
| 真实 DeepSeek 和模拟业务接口 | 每轮 59/59，三轮 177/177 |
| 实际模型调用 | 33/33，18 次经过乘客 HTTP 入口，另 15 次直接经过模型对话服务验证中文工具调用 |
| 本地中文文本路径 | 132 次，P50 3 ms，P95 17 ms，范围 1–162 ms。排除专门注入的六次写超时，包含每轮首个请求 |
| 经模型的乘客 HTTP 请求 | 18 次，P50 1,037 ms，P95 1,895 ms，范围 684–1,895 ms |
| 中文直接调用模型对话服务 | 15 次，P50 1,111 ms，P95 1,892 ms，范围 742–1,892 ms |
| 客舱和运行策略回归、Node 构建 | 343/343，构建通过 |

HTTP 耗时从发起请求到读完 SSE。直接调用从服务入口计到返回。测试期间关闭座位音频。调试中模型曾在明确请求下返回普通文本或空回复，英文查询也曾出现伪工具文本。最终版本在本轮意图可授权时指定已启用的工具，并校验实参。英文开关查询直接按 `lightOpen` 组织回复。

## 逐项实测

前 54 项经过文字或语音 HTTP 入口，后 5 项直接走模型对话服务验证中文工具调用。表中回复和设备请求取第一轮，末列为三轮完成耗时。调用列记录模拟 ASR、模型和下游业务接口，会话准备阶段的资料读取单独处理。

| # | 座位与乘客话术 | 实际调用（按顺序） | 实际回复 | 三轮 ms |
|---|---|---|---|---|
| 1 | 3B 帮我进入办公模式 | `POST /admin-api/cabin/broadcast/mode-seat {"mode":1,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | 已为您下发办公模式指令。 | 162 / 63 / 54 |
| 2 | 3B 帮我进入放松模式 | `POST /admin-api/cabin/broadcast/mode-seat {"mode":2,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | 已为您下发放松模式指令。 | 7 / 10 / 2 |
| 3 | 3B 帮我进入睡眠模式 | `POST /admin-api/cabin/broadcast/mode-seat {"mode":3,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | 已为您下发睡眠模式指令。 | 9 / 3 / 2 |
| 4 | 3B 帮我进入个性模式 | `POST /admin-api/cabin/broadcast/mode-seat {"mode":4,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | 已为您下发个人模式指令。 | 3 / 3 / 1 |
| 5 | 3B 把氛围灯调成蓝色，亮度一半 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=0&g=0&b=255&brightness=128` | 已为您下发客舱顶灯颜色调整为 RGB(0, 0, 255)，亮度 50%的指令，请稍候。 | 16 / 24 / 2 |
| 6 | 3B 关闭氛围灯 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=false` | 已为您下发关闭客舱顶灯的指令，请稍候。 | 9 / 11 / 1 |
| 7 | 3B 再打开 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=true` | 已为您下发打开客舱顶灯的指令，请稍候。 | 4 / 26 / 7 |
| 8 | 3B 打开呼吸灯 | `POST /admin-api/tcp-client/cmd/cabin/scene?seatNo=3B&preset=breath` | 已为您下发切换至 breath 客舱场景的指令，请稍候。 | 4 / 3 / 2 |
| 9 | 3B 切换到流水灯 | `POST /admin-api/tcp-client/cmd/cabin/scene?seatNo=3B&preset=flow` | 已为您下发切换至 flow 客舱场景的指令，请稍候。 | 3 / 10 / 2 |
| 10 | 3B 恢复常亮 | `POST /admin-api/tcp-client/cmd/cabin/scene?seatNo=3B&preset=normal` | 已为您下发切换至 normal 客舱场景的指令，请稍候。 | 11 / 4 / 1 |
| 11 | 3B 氛围灯现在开着吗？ | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 氛围灯已关闭。 | 18 / 11 / 3 |
| 12 | 3B 氛围灯现在是什么灯效？ | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 灯效为呼吸。 | 3 / 3 / 3 |
| 13 | 3B 把氛围灯亮度调到40% | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=255&g=180&b=80&brightness=102` | 已为您下发客舱顶灯颜色调整为 RGB(255, 180, 80)，亮度 40%的指令，请稍候。 | 5 / 3 / 2 |
| 14 | 3B 把氛围灯调成蓝色 | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=0&g=0&b=255&brightness=101` | 已为您下发客舱顶灯颜色调整为 RGB(0, 0, 255)，亮度 40%的指令，请稍候。 | 5 / 10 / 3 |
| 15 | 3B 氛围灯改成暖色 | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 氛围灯亮度要调到百分之多少？ | 6 / 2 / 1 |
| 16 | 3B 换蓝色，还是一半 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=0&g=0&b=255&brightness=128` | 已为您下发客舱顶灯颜色调整为 RGB(0, 0, 255)，亮度 50%的指令，请稍候。 | 4 / 6 / 1 |
| 17 | 3B 把氛围灯调到40% | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 氛围灯想配什么颜色？ | 3 / 2 / 1 |
| 18 | 3B 算了 | 无 | 好的，已取消这次氛围灯调整。 | 3 / 3 / 1 |
| 19 | 3B 别开氛围灯 | 无 | 好的，保持当前设置。 | 3 / 8 / 1 |
| 20 | 3B 要是打开睡眠模式会怎样？ | 无 | 可以切换本座模式，也可以单独设置氛围灯的颜色、亮度和效果。 | 10 / 3 / 1 |
| 21 | 3B 打开3A的氛围灯 | 无 | 这里只能控制您当前座位的设备。 | 3 / 2 / 1 |
| 22 | 3B 把氛围灯调到130% | 无 | 请说一个 0 到 100 之间的整数百分比。 | 3 / 1 / 1 |
| 23 | 3B 打开办公模式 | `POST /admin-api/cabin/broadcast/mode-seat {"mode":1,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | 本座模式切换过于频繁，请稍后再试。 | 2 / 3 / 2 |
| 24 | 3B 打开办公模式 | `POST /admin-api/cabin/broadcast/mode-seat {"mode":1,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | 模式指令已提交，座位屏幕暂未确认送达。 | 3 / 13 / 3 |
| 25 | 3C 打开氛围灯 | 无 | 当前座位暂时无法使用这项服务。 | 2 / 4 / 1 |
| 26 | 3B 把氛围灯亮度调到百分之四十 | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=255&g=180&b=80&brightness=102` | 已为您下发客舱顶灯颜色调整为 RGB(255, 180, 80)，亮度 40%的指令，请稍候。 | 7 / 12 / 2 |
| 27 | 3B 把灯调暗点 | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=255&g=180&b=80&brightness=77` | 已为您下发客舱顶灯颜色调整为 RGB(255, 180, 80)，亮度 30%的指令，请稍候。 | 4 / 12 / 1 |
| 28 | 3B 我喜欢蓝色氛围灯 | 无 | 请明确您希望进行哪项调整。 | 5 / 6 / 2 |
| 29 | 3B 把灯调暗点 | 无 | 您想调整阅读灯还是氛围灯？ | 13 / 4 / 1 |
| 30 | 3B 打开氛围灯然后关掉 | 无 | 请先选一项设备操作。 | 2 / 9 / 1 |
| 31 | 3B 打开全舱氛围灯 | 无 | 这里只能控制您当前座位的设备。 | 1 / 2 / 1 |
| 32 | 99B 打开氛围灯 | 无 | 当前座位暂时无法使用这项服务。 | 1 / 1 / 1 |
| 33 | 3B 氛围灯亮度多少？ | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 暂时读不到本座氛围灯的这项状态。 | 2 / 2 / 1 |
| 34 | 3B 把氛围灯调成蓝色 | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 氛围灯亮度要调到百分之多少？ | 4 / 7 / 3 |
| 35 | 3B 50 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=0&g=0&b=255&brightness=128` | 已为您下发客舱顶灯颜色调整为 RGB(0, 0, 255)，亮度 50%的指令，请稍候。 | 5 / 9 / 2 |
| 36 | 3B 关闭氛围灯（模拟语音） | `ASR synthetic transcript`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=false` | 已为您下发关闭客舱顶灯的指令，请稍候。 | 12 / 5 / 5 |
| 37 | 3B 关闭氛围灯（模拟语音） | `ASR synthetic transcript` | 已收到这次请求。 | 2 / 9 / 2 |
| 38 | 3B 关闭氛围灯 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=false` | 关闭客舱顶灯的指令下发失败，请稍后再试。 | 2 / 4 / 6 |
| 39 | 3B 进入睡眠模式 | `POST /admin-api/cabin/broadcast/mode-seat {"mode":3,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | 尚未收到模式切换回执，请先确认本座设备状态。 | 254 / 268 / 258 |
| 40 | 3B 关闭氛围灯 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=false` | 尚未收到灯光控制回执，请先查询本座灯光状态。 | 257 / 277 / 259 |
| 41 | 3B Could you switch to sleep mode? | `LLM 200 cabin_mode`<br>`POST /admin-api/cabin/broadcast/mode-seat {"mode":3,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | Your request has been sent. | 1471 / 1118 / 1133 |
| 42 | 3B Could you check the ceiling light status? | `LLM 200 cabin_status`<br>`GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | Your ambient light is off. | 1211 / 765 / 860 |
| 43 | 3B Could you turn off the ambient light? | `LLM 200 cabin_control`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=false` | Turn off ceiling light: Your request has been sent. | 836 / 1282 / 878 |
| 44 | 3B Could you set the ambient light to RGB 0, 0, 255 at 50% brightness? | `LLM 200 cabin_control`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=0&g=0&b=255&brightness=128` | Ceiling light settings: Your request has been sent. | 1895 / 895 / 1793 |
| 45 | 3B Could you set the lighting scene to breathing? | `LLM 200 cabin_control`<br>`POST /admin-api/tcp-client/cmd/cabin/scene?seatNo=3B&preset=breath` | Cabin scene: Your request has been sent. | 960 / 1185 / 803 |
| 46 | 3B 请简短介绍你可以提供什么服务 | `LLM 200 stop` | 我可以帮您调节座椅、灯光和温度。例如，可以打开阅读灯、调节座椅角度，或开启座椅按摩。 | 684 / 949 / 1114 |
| 47 | 3B 把氛围灯调成蓝色，亮度一半 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=0&g=0&b=255&brightness=128` | 已为您下发客舱顶灯颜色调整为 RGB(0, 0, 255)，亮度 50%的指令，请稍候。 | 17 / 8 / 2 |
| 48 | 3B 关闭氛围灯 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=false` | 已为您下发关闭客舱顶灯的指令，请稍候。 | 7 / 7 / 1 |
| 49 | 3B 再打开 | `POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=true` | 已为您下发打开客舱顶灯的指令，请稍候。 | 10 / 7 / 2 |
| 50 | 3B 氛围灯现在开着吗？ | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 氛围灯已开启。 | 4 / 4 / 1 |
| 51 | 3B 氛围灯现在是什么颜色？ | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 颜色为蓝色。 | 7 / 5 / 1 |
| 52 | 3B 氛围灯亮度多少？ | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 亮度约为50%。 | 3 / 4 / 1 |
| 53 | 3B 把氛围灯切换到流水效果 | `POST /admin-api/tcp-client/cmd/cabin/scene?seatNo=3B&preset=flow` | 已为您下发切换至 flow 客舱场景的指令，请稍候。 | 7 / 7 / 3 |
| 54 | 3B 氛围灯现在是什么灯效？ | `GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 灯效为流水。 | 2 / 3 / 4 |
| 55 | 3B 帮我进入睡眠模式（中文模型） | `LLM 200 cabin_mode`<br>`POST /admin-api/cabin/broadcast/mode-seat {"mode":3,"aircraftNo":"B-SMOKE","seatNo":"3B"}` | 已为您下发睡眠模式指令。 | 1800 / 742 / 927 |
| 56 | 3B 关闭氛围灯（中文模型） | `LLM 200 cabin_control`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=3B&on=false` | 已为您下发关闭客舱顶灯的指令，请稍候。 | 790 / 1250 / 1250 |
| 57 | 3B 将氛围灯设置为 RGB 0,0,255，亮度 50%（中文模型） | `LLM 200 cabin_control`<br>`POST /admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=3B&r=0&g=0&b=255&brightness=128` | 已为您下发客舱顶灯颜色调整为 RGB(0, 0, 255)，亮度 50%的指令，请稍候。 | 1892 / 940 / 1111 |
| 58 | 3B 请将场景设置为呼吸（中文模型） | `LLM 200 cabin_control`<br>`POST /admin-api/tcp-client/cmd/cabin/scene?seatNo=3B&preset=breath` | 已为您下发切换至 breath 客舱场景的指令，请稍候。 | 1789 / 1200 / 1073 |
| 59 | 3B 查询氛围灯状态（中文模型） | `LLM 200 cabin_status`<br>`GET /admin-api/tcp/state/cabin/light?aircraftNo=B-SMOKE&seatNo=3B` | 氛围灯已关闭，颜色为蓝色，亮度约为50%，灯效为呼吸。 | 903 / 1312 / 814 |

## 联调与复现

- `ep129` 的状态由硬件反馈和控制指令共同维护。测试覆盖 RGB 非零但 `lightOpen="0"`，另用可更新的模拟状态验证关灯后再开时蓝色和 50% 亮度仍可读回。
- 查询的 `brightness` 暂按写接口的 0–255 处理。现场用 3B 蓝色 50% 核对响应亮度是否为 128、目标灯位是否为 6，并观察相邻座位。
- 本轮 `managedSeats` 为 `3A,3B`，拒绝列表外座位。未配置清单时，服务按请求绑定与座号格式校验。
- 现场验收还需在同一 3B、同一模型、音色和预热条件下与基线比较首字、语音准备、UE 实际起播，并核对 UE 离线时模式接口的回执。
- 本地执行 `bun scripts/cabin-lighting-smoke.ts` 可复现模拟测试。环境中提供 `CABIN_LIGHT_MODEL_KEY` 后，执行 `CABIN_LIGHT_MODEL=deepseek-v3.2 bun scripts/cabin-lighting-smoke.ts` 可复测真实网关。脚本逐行输出 JSON，断言失败时退出码为 1。
