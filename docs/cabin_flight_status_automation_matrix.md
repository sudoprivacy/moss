# 客舱飞行状态自动化处理矩阵

更新时间：2026-11-11
适用分支：`codex/cabin-status-mode-tools`

本文按当前代码整理客舱自动化的实际行为，用于客户现场联调和日志排查。文档描述的是已经实现的逻辑，不把尚未接入的业务要求当成已完成能力。

## 1. 处理入口和通用规则

### 1.1 飞行状态消息

Moss 作为 WebSocket 客户端连接配置项 `cabin.flightStateWsUrl`。只有同时满足 `cabin.automationEnabled=true` 和 `flightStateWsUrl` 已配置时，才会启动连接。收到消息后按以下顺序处理：

1. 外层消息必须是 JSON 对象，且 `type` 必须为 `flight_data`。
2. `content` 必须是 JSON 字符串，并解析为飞行数据对象。
3. 仅接受 `id=1021` 且 `mavpackettype=CE25_AUTO_GUIDE_DATA` 的数据。
4. 从 `afcs_status_data[7]` 读取阶段码，数字或可转换为数字的字符串均可。
5. 同一阶段码连续重复到达时只记录 `flight.phase.duplicate`，不会重新执行完整阶段任务；已下发的座椅/桌板控制仍会按计划在 20 秒后复核。
6. 阶段码变化后串行进入阶段任务队列；前一个阶段任务完成后才执行下一个阶段任务。每次变化都会生成新的阶段版本，使旧阶段尚未执行的延迟复核失效。

### 1.2 参与处理的座位

座位来源按以下优先级处理：

1. 读取数据库中 `status=active` 的托管座位，并按 `seatNo` 去重。
2. 如果数据库没有任何 active 座位，则解析 `cabin.managedSeats`（逗号分隔），写入临时 `AUTO` 航班的托管座位，再读取这些座位。
3. 平板请求 `/v1/auth/token` 或乘客上下文成功后，也会把真实座位上下文写入托管座位表；真实航班信息优先于 `AUTO` 兜底记录。

因此，`managedSeats` 是没有任何 active 托管座位时的兜底座位集合。只要数据库已有 active 座位，阶段自动化优先处理数据库座位，不会把配置值和数据库座位合并后重复处理。

### 1.3 状态接口的通用判断

- 状态接口：`GET /admin-api/tcp/hardware/status?target=<target>&key=<key>`。
- 请求基础地址来自 `cabin.controlBaseUrl`，如配置 `controlAuth`，原样放入 `Authorization` 请求头。
- 业务响应要求 HTTP 成功且 JSON `code` 缺失、为 `0` 或字符串 `"0"`；非上述情况视为失败。
- 需要判断的字段缺失、接口请求失败、返回 `data` 为空时，只计入 `statusFailures`，不会凭空生成业务告警。
- Boolean 字段支持布尔值、数字和字符串；`true/1/yes/on/扣合/已扣/在席` 解释为真，其他字符串解释为假。

## 2. 阶段码和阶段任务总表

| 原始阶段码 | 原始阶段名称 | 代码阶段名 | 是否执行自动化任务 | 阶段音频 | 状态检测 | 硬件控制 | 业务告警 |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | 滑入 | `taxi_in` | 是 | 无阶段广播 | `ceiling_state`、`safety`、`bag`、`posture`、`tray`、`reading_light` | 客舱顶灯关闭；座椅归位；必要时收桌板；阅读灯关闭；座椅/桌板 20 秒后复核并最多重发一次 | 在席、安全带、行李箱锁定、座椅、桌板 |
| 16 | 划出/滑行 | `taxiing` | 是 | 滑行阶段中英文全机广播 | `ceiling_state`、`safety`、`posture`、`tray`、`reading_light` | 同上 | 在席、安全带、座椅、桌板 |
| 2 | 起飞前准备 | `takeoff_prepare` | 是 | 无阶段广播 | `ceiling_state`、`safety`、`posture`、`tray`、`reading_light` | 同上 | 在席、安全带、座椅、桌板 |
| 3 | 起飞滑跑 | `takeoff` | 是 | 无阶段广播 | `ceiling_state`、`safety`、`posture`、`tray`、`reading_light` | 同上 | 在席、安全带、座椅、桌板 |
| 4 | 起飞抬轮 | `takeoff` | 阶段名与 3 相同；若从 3 变为 4，原始阶段码变化，会再次执行一次任务 | 无阶段广播 | 同上 | 同上 | 同上 |
| 5 | 初始爬升 | `climb` | 是 | 爬升阶段中英文全机广播 | `safety` | 无本阶段自动硬件控制 | 在席、安全带 |
| 6 | 爬升 | `climb` | 阶段名与 5 相同；若从 5 变为 6，原始阶段码变化，会再次执行一次任务 | 爬升阶段中英文全机广播 | `safety` | 无本阶段自动硬件控制 | 在席、安全带 |
| 7 | 巡航 | `cruise` | 否，记录 `phase.task.skipped` | 无 | 无 | 无 | 无 |
| 8 | 下降 | `descent` | 是 | 下降阶段中英文全机广播 | `ceiling_state`、`safety`、`posture`、`tray`、`reading_light` | 客舱顶灯关闭；座椅归位；必要时收桌板；阅读灯关闭 | 在席、安全带、座椅、桌板 |
| 9 | 初始进近 | `landing_approach` | 是 | 降落进近阶段中英文全机广播 | `ceiling_state`、`safety`、`posture`、`tray`、`reading_light` | 同上 | 在席、安全带、座椅、桌板 |
| 10 | 最终进近 | `landing_approach` | 阶段名与 9 相同；原始阶段码变化时再次执行 | 降落进近阶段中英文全机广播 | 同上 | 同上 | 同上 |
| 11 | 拉平 | `landing_approach` | 原始阶段码变化时再次执行 | 降落进近阶段中英文全机广播 | 同上 | 同上 | 同上 |
| 12 | 跑道对准 | `landing_approach` | 原始阶段码变化时再次执行 | 降落进近阶段中英文全机广播 | 同上 | 同上 | 同上 |
| 13 | 低机头 | `landing_approach` | 原始阶段码变化时再次执行 | 降落进近阶段中英文全机广播 | 同上 | 同上 | 同上 |
| 14 | 着陆滑跑 | `landing_approach` | 原始阶段码变化时再次执行 | 降落进近阶段中英文全机广播 | 同上 | 同上 | 同上 |
| 15 | 着陆滑跑结束 | `landing_approach` | 原始阶段码变化时再次执行 | 降落进近阶段中英文全机广播 | 在上面基础上增加 `bag` | 同上 | 在席、安全带、行李遗留、座椅、桌板 |
| 17 | 复飞 | `go_around` | 否，记录 `phase.task.skipped` | 无 | 无 | 无 | 无 |
| 其他 | 未知 | `unknown` | 否，记录 `phase.task.skipped` | 无 | 无 | 无 | 无 |

> 注意：阶段名相同不等于一定只执行一次。去重判断使用原始阶段码 `lastPhaseCode`，例如 5→6、9→10 都会再次执行；只有原始阶段码完全相同的重复消息才会跳过。

## 3. 阶段音频处理

阶段音频只配置在 `taxiing`、`climb`、`descent`、`landing_approach` 四个代码阶段。音频正文由固定中文文案和英文文案拼接为 `中文\n\nEnglish`，再调用 `cabin.ttsUrl` 生成 WAV。相同阶段、文案、模型、音色、语言和版本会命中本地缓存，不重复调用 TTS。

| 代码阶段名 | 音频标题 | 播报内容摘要 | 播放接口 |
| --- | --- | --- | --- |
| `taxiing` | 滑行阶段广播 | 请乘客坐好、系好安全带、收起小桌板、调直座椅靠背、打开调光窗，并在安全带灯熄灭前保持就座。 | `POST /admin-api/cabin/broadcast/audio-all` |
| `climb` | 爬升阶段广播 | 爬升可能颠簸，请系好安全带；可调低座椅靠背或使用小桌板，达到巡航高度后提供客舱服务。 | 同上 |
| `descent` | 下降阶段广播 | 飞机开始下降，请回座、系紧安全带；卫生间停止使用。 | 同上 |
| `landing_approach` | 降落进近阶段广播 | 即将着陆，请系好安全带、收起小桌板和脚踏板、调直座椅靠背、打开调光窗，电子设备切换飞行模式或关闭。 | 同上 |

全机广播请求为 multipart：

```text
file       WAV 文件
title      阶段广播标题
aircraftNo 飞机号
```

请求头：`x-hardware-api-key: <broadcastApiKey>`；`Authorization` 优先使用 `broadcastAuth`，未配置时回退 `controlAuth`。HTTP 成功且响应业务 `code=0`（或缺失）才记录为成功。广播失败会记录失败，但不会阻止后续状态检测和控制。

## 4. 状态检测、判断和控制明细

### 4.1 客舱顶灯（氛围灯）

适用阶段：`taxi_in`、`taxiing`、`takeoff_prepare`、`takeoff`、`descent`、`landing_approach`。

| 步骤 | 接口/字段 | 判断 | 结果 |
| --- | --- | --- | --- |
| 查询 | `GET .../hardware/status?target=cabin&key=ceiling_state`，读取 `data.on` | `on=true` | 下发关闭指令 |
| 查询 | 同上 | `on=false` | 不重复控制 |
| 控制 | `POST .../tcp-client/cmd/cabin/ceiling/light?on=false` | HTTP/业务成功 | 再查 `ceiling_state` |
| 复核 | 读取 `data.on` | `on=false` | 控制完成 |
| 复核失败 | 字段缺失、请求失败或 `on` 仍为真 | 生成 `HARDWARE_STATE_NOT_REACHED` |

### 4.2 座位安全状态

适用阶段：`taxi_in`、`taxiing`、`takeoff_prepare`、`takeoff`、`climb`、`descent`、`landing_approach`。

| 状态接口 | 字段 | 判断 | 告警 |
| --- | --- | --- | --- |
| `GET .../hardware/status?target=<seatNo>&key=safety` | `presence` | 字段存在且为假 | `PASSENGER_NOT_PRESENT`，warning |
| 同上 | `seatbelt` | 字段存在且为假 | `SEATBELT_NOT_FASTENED`，critical |
| 同上 | 任一字段缺失或接口失败 | 无法判断 | 只增加 `statusFailures`，不生成业务告警 |

### 4.3 座椅靠背

适用阶段：`taxi_in`、`taxiing`、`takeoff_prepare`、`takeoff`、`descent`、`landing_approach`。

| 接口/字段 | 判断 | 控制 | 延迟复核目标 |
| --- | --- | --- | --- |
| `GET .../hardware/status?target=<seatNo>&key=posture`，读取 `data.position` | `position != 0` | 先生成 `SEAT_NOT_UPRIGHT`，再 `POST .../tcp-client/cmd/seat/cushion?seatNo=<seatNo>&position=0` | 首次指令成功后等待 20 秒；阶段未变化时要求 `position=0` |
| 同上 | `position=0` | 不控制、不告警 | 已满足目标 |
| 同上 | 字段缺失、不可转数字或接口失败 | 不控制、不生成座椅业务告警 | 计入 `statusFailures` |

20 秒后如果 `position` 仍不为 `0`，生成内部 `HARDWARE_STATE_NOT_REACHED`，再下发一次相同的 `position=0` 指令，然后结束；第二次指令之后不再查询状态、不再进行第三次重试。

### 4.4 小桌板

适用阶段：`taxi_in`、`taxiing`、`takeoff_prepare`、`takeoff`、`descent`、`landing_approach`。

当前使用现场真实字段 `flipped` 和 `open`，不使用旧的 `tray_state` 或 `tray_flipped` 字段。

| `flipped` | `open` | 判断 | 告警/控制 |
| --- | --- | --- | --- |
| `true` | 任意 | 桌板仍处于展开/翻起状态，不能直接执行收起，避免硬件卡滞 | `TRAY_NOT_FOLDED`；不下发收桌板指令 |
| `false` | `true` | 桌板已折叠但仍打开 | `TRAY_NOT_CLOSED`；`POST .../tcp-client/cmd/seat/tray/close?seatNo=<seatNo>` |
| `false` | `false` | 桌板已关闭 | 不告警、不控制 |
| 任一字段缺失或接口失败 | - | 无法判断 | 只计入 `statusFailures` |

首次收桌板指令成功后等待 20 秒，再查询 `tray`：

- `open=false` 且 `flipped=false`：目标已达到，结束。
- `open=true` 且 `flipped=false`：生成内部 `HARDWARE_STATE_NOT_REACHED`，再下发一次收桌板指令，然后结束，不再复核第二次指令。
- `flipped=true`：不重发关闭指令，避免硬件卡滞。
- 接口失败或字段缺失：无法确认当前状态，只记录复核跳过，不盲目重发。

### 4.5 阅读灯

适用阶段同座椅/桌板检测阶段。

| 接口/字段 | 判断 | 控制 | 复核目标 |
| --- | --- | --- | --- |
| `GET .../hardware/status?target=<seatNo>&key=reading_light`，读取 `data.on` | `on=true` | `POST .../tcp-client/cmd/seat/light?seatNo=<seatNo>&on=false` | `on=false` |
| 同上 | `on=false` | 不控制 | 已满足目标 |
| 字段缺失或接口失败 | 无法判断 | 不控制，计入 `statusFailures` | - |

### 4.6 行李箱

行李检查只看原始阶段码，不看映射后的阶段名：阶段码 `1` 和 `15` 才会调用 `key=bag`。

| 阶段码 | 状态接口 | 字段和判断 | 告警 |
| ---: | --- | --- | --- |
| 1 | `GET .../hardware/status?target=<seatNo>&key=bag` | `data.bagLock` 必须存在且为真；为假表示行李箱未锁定 | `BAG_NOT_LOCKED`，critical |
| 15 | 同上 | `data.higherBag` 和 `data.lowerBag` 至少一个字段存在；任一为真表示仍可能有行李 | `BAG_LEFT_BEHIND_POSSIBLE`，warning |
| 1/15 | 同上 | 返回 `data={}` 或字段均缺失 | 只计入 `statusFailures`，不误报 |

## 5. 告警和告警推送

### 5.1 业务告警类型

| 告警类型 | 触发条件 | 默认级别 | 是否自动控制 |
| --- | --- | --- | --- |
| `PASSENGER_NOT_PRESENT` | `safety.presence=false` | warning | 否 |
| `SEATBELT_NOT_FASTENED` | `safety.seatbelt=false` | critical | 否 |
| `SEAT_NOT_UPRIGHT` | `posture.position != 0` | critical | 调座椅到 0 |
| `TRAY_NOT_FOLDED` | `tray.flipped=true` | critical | 否，避免卡滞 |
| `TRAY_NOT_CLOSED` | `tray.flipped=false` 且 `tray.open=true` | critical | 收桌板 |
| `BAG_NOT_LOCKED` | 阶段 1 且 `bag.bagLock=false` | critical | 否 |
| `BAG_LEFT_BEHIND_POSSIBLE` | 阶段 15 且 `higherBag/lowerBag` 任一为真 | warning | 否 |
| `HARDWARE_CONTROL_FAILED` | 控制接口 HTTP/业务失败或请求异常 | critical | - |
| `HARDWARE_STATE_NOT_REACHED` | 座椅/桌板在首次控制 20 秒后仍未达到目标，或阅读灯/客舱顶灯立即复核未达到目标 | critical | 座椅/桌板会再下发一次；灯光不自动重试 |

同一飞机、航班、日期、座位、阶段码、告警类型只在当前进程生命周期内首次生成一次，避免同一阶段重复刷告警。告警写入 `cabin_alerts`，默认 `status=active`。当前代码没有自动恢复逻辑，硬件后来恢复不会自动把旧告警改为 `resolved`。

### 5.2 对外座位告警接口

一个座位在一次阶段任务内的多个问题会聚合为一次调用：

```http
POST /admin-api/cabin/broadcast/error-seat
Content-Type: application/json
x-hardware-api-key: <broadcastApiKey>
Authorization: <broadcastAuth 或 controlAuth>
```

```json
{
  "aircraftNo": "B-WITHFLIGHT-01",
  "seatNo": "8B",
  "title": "座位告警",
  "content": "8B 座位安全检查异常：安全带未扣合；小桌板未收起。",
  "contentEN": "8B seat safety check abnormal: seat belt is not fastened; tray table is not stowed."
}
```

该接口失败只影响 Pad 上的告警推送，不影响 Moss 内部告警落库，也不阻止其他座位继续处理。

## 6. 外部接口清单

| 外部能力 | 方法/地址 | 调用时机 | 主要参数/字段 | 认证 |
| --- | --- | --- | --- | --- |
| 飞行状态 WebSocket | `WS <flightStateWsUrl>` | 服务启动后持续连接；断线自动重连 | 外层 `type=flight_data`；`content` 内 `id`、`mavpackettype`、`afcs_status_data[7]` | 由 WS 地址/网络策略决定 |
| 阶段 TTS | `POST <ttsUrl>` | 需要阶段广播且本地缓存未命中时 | `model`、`voice`、`input`、`response_format=wav`、`language` | 可选 `Authorization: Bearer <ttsApiKey>` |
| 硬件状态 | `GET <controlBaseUrl>/admin-api/tcp/hardware/status` | 各阶段按表格查询 | `target`、`key` | 可选 `Authorization: <controlAuth>` |
| 座椅归位 | `POST <controlBaseUrl>/admin-api/tcp-client/cmd/seat/cushion` | `posture.position != 0`；20 秒后仍未归位时最多重发一次 | `seatNo`、`position=0` | `controlAuth` |
| 小桌板收起 | `POST <controlBaseUrl>/admin-api/tcp-client/cmd/seat/tray/close` | `flipped=false && open=true`；20 秒后仍为该状态时最多重发一次 | `seatNo` | `controlAuth` |
| 阅读灯关闭 | `POST <controlBaseUrl>/admin-api/tcp-client/cmd/seat/light` | `reading_light.on=true` | `seatNo`、`on=false` | `controlAuth` |
| 客舱顶灯关闭 | `POST <controlBaseUrl>/admin-api/tcp-client/cmd/cabin/ceiling/light` | `ceiling_state.on=true` | `on=false` | `controlAuth` |
| 全机阶段广播 | `POST <broadcastApiBaseUrl 或 controlBaseUrl>/admin-api/cabin/broadcast/audio-all` | 阶段音频生成/命中缓存后 | multipart `file`、`title`、`aircraftNo` | `x-hardware-api-key`；Authorization 优先 `broadcastAuth` |
| 座位告警推送 | `POST <broadcastApiBaseUrl 或 controlBaseUrl>/admin-api/cabin/broadcast/error-seat` | 座位存在一个或多个业务问题时 | `aircraftNo`、`seatNo`、`title`、`content`、`contentEN` | 同上 |

`broadcastApiBaseUrl` 未配置时回退 `controlBaseUrl`。广播接口要求 `broadcastApiKey`；没有配置广播 API Key 时，广播客户端会将调用标记为 skipped，不会发送请求。

## 7. 一次阶段任务的实际顺序

```text
flight_data
  -> 校验消息类型、id、mavpackettype、阶段码
  -> 阶段码变化检查
  -> 加入串行阶段任务队列
  -> 读取 active managed seats；无座位时使用 managedSeats 兜底
  -> 如果该阶段有广播文案：TTS 生成/命中缓存
  -> 调用 audio-all 全机播放
  -> 检查客舱顶灯，必要时关闭并复核
  -> 对每个座位依次：
       查询 safety/bag/posture/tray/reading_light（按阶段需要）
       生成内部告警
       聚合调用 error-seat
       下发座椅、桌板、阅读灯控制
       阅读灯立即查询状态复核
  -> 写入 phase.task.summary
  -> 首次座椅/桌板指令成功后，非阻塞等待 20 秒
       检查阶段版本和原始阶段码
       阶段未变化：查询对应硬件状态
       已达到目标：结束
       未达到目标且仍可安全控制：重发一次，结束且不再复核
       阶段已变化：取消旧任务，由新阶段任务按当前规则处理
```

阶段广播失败不会中断座位检查；某个座位状态查询失败不会阻止其他座位继续处理。阶段任务最终的 `phase.task.summary.ok` 只反映初始阶段任务中的 `controlFailures` 和 `statusFailures`。20 秒后的复核与重试是异步后续流程，其结果应查看对应的 `hardware.control.delayed_*` 日志，不能只看先前已经写出的阶段汇总。

### 7.1 延迟复核期间发生阶段变化

- 延迟任务保存下发控制时的原始阶段码和阶段版本。
- 20 秒到期前阶段发生变化时，旧任务不会继续查询或重发旧阶段指令。
- 新阶段进入正常阶段任务，重新查询当前硬件状态；如果新阶段仍要求座椅归位或桌板关闭，会按新阶段重新告警、控制并建立新的 20 秒复核。
- 为避免竞态，延迟任务在查询状态前和状态接口返回后都会校验阶段版本。即使阶段恰好在状态查询过程中变化，也不会根据旧阶段结果重发指令。
- 同一座位、同一控制类型只保留一个等待中的复核定时器；新阶段下发相同控制时会替换旧定时器。

## 8. 日志排查关键事件

日志文件默认是 `<rootDir>/logs/cabin-automation.jsonl`，可用 `cabin.automationLogFile` 修改。重点事件如下：

| 日志事件 | 含义 |
| --- | --- |
| `ws.connect`、`ws.open`、`ws.error`、`ws.close`、`ws.reconnect.scheduled` | 飞行状态 WS 连接和重连情况 |
| `ws.message.raw`、`ws.message.parsed` | 收到的原始消息及解析后的内容 |
| `flight_data.ignored` | `id` 或 `mavpackettype` 不匹配，未进入阶段处理 |
| `flight_data.missing_phase` | `afcs_status_data[7]` 不存在或不可解析 |
| `flight.phase.changed`、`flight.phase.duplicate` | 阶段变化或重复阶段消息 |
| `phase.task.skipped` | 巡航、复飞或未知阶段当前未执行自动化 |
| `seat.registry.loaded` | 本次阶段实际处理的座位列表 |
| `broadcast.tts.request/generated/cache_hit/failed/error` | 阶段音频生成和缓存 |
| `broadcast.audio_all.request/success/failed/skipped` | 全机阶段广播调用 |
| `hardware.status.request/response/error` | 状态查询请求、响应和异常 |
| `hardware.control.request/response/error` | 硬件控制请求、响应和异常 |
| `hardware.control.verify_failed` | 控制接口返回成功，但复查状态未达到目标 |
| `hardware.control.delayed_verify_scheduled` | 座椅或桌板首次控制成功，已安排 20 秒后复核 |
| `hardware.control.delayed_verify_success` | 20 秒后状态已达到目标，不重发 |
| `hardware.control.delayed_verify_cancelled` | 飞行阶段已变化，旧阶段复核任务取消 |
| `hardware.control.delayed_verify_skipped` | 状态接口失败、字段缺失或桌板变成未折叠状态，未重发 |
| `hardware.control.delayed_retry` | 20 秒后仍未达到目标，准备且只重发一次 |
| `hardware.control.delayed_verify_error` | 延迟复核流程发生未预期异常 |
| `alert.created` | Moss 内部告警落库 |
| `broadcast.error_seat.request/success/failed/skipped` | 座位告警推送 |
| `phase.task.summary` | 本阶段座位数、告警数、控制数、状态失败数、广播失败数汇总 |

现场看到“没有告警”时，必须先区分三种情况：

1. `phase.task.skipped`：阶段本来就未实现自动化，例如 7 或 17。
2. `hardware.status.response` 中字段缺失：代码无法证明异常，只会增加 `statusFailures`，不会误报。
3. 状态字段明确表示正常：不会生成告警，也不会重复控制。

建议使用同一 `requestId` 串联 `flight.phase.changed`、状态查询、控制、告警和 `phase.task.summary`，不要只看单条 `inbound` 或广播日志。

## 9. 当前实现边界

- 当前只自动关闭客舱顶灯、调直座椅、收起已折叠但仍打开的小桌板、关闭阅读灯；没有自动控制调光窗、座椅/桌板锁定、卫生间锁定或安全带信号灯。
- `TRAY_NOT_FOLDED` 只告警不控制；20 秒复核时发现 `flipped=true` 也不会重发关闭指令，这是代码明确的防卡滞策略，不能解释成“收桌板接口调用失败”。
- 20 秒复核和一次重发只适用于座椅归位与桌板关闭。阅读灯、客舱顶灯仍采用控制成功后立即查询一次的原有方式，当前不做延迟重试。
- 第二次座椅/桌板控制指令发出后按需求直接结束，不验证最终执行结果，也不会进行第三次重试。第二次请求本身的成功或失败仍会完整记录在 `hardware.control.response/error` 日志中，`details.attempt=retry`。
- 行李检查依赖对方 `bag` 接口返回 `bagLock`、`higherBag`、`lowerBag`。如果现场返回 `data={}`，行李业务告警不会触发，只会体现为状态失败。
- 阶段音频是否真正从 Pad 播放成功，以对方 `audio-all` 的业务响应为准；Moss 当前没有播放完成回调。HTTP 200 但对方业务未返回成功计数时，仍需结合对方接口定义和返回体判断。
- 当前告警没有自动恢复逻辑；恢复状态需要通过管理端或后续运维流程处理。
- 巡航（7）和复飞（17）目前只完成阶段映射，不执行状态检测、硬件控制、阶段音频和告警。
