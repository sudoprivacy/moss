---
name: cabin-hardware-control
displayName: 客舱硬件控制
description: Use this skill when a cabin passenger asks to control real cabin hardware, especially opening or closing the tray table, seat-side devices, lights, seat posture, or other equipment through customer cabin control APIs. The skill must use server-provided cabin_context for seat identity.
version: 1.2.0
category: 客舱服务
emoji: "🛫"
---

# Cabin Hardware Control

Use this skill for passenger requests that require real cabin hardware control.
Do not use this skill for hardware status questions such as 当前座椅角度是多少 or 小桌板收好了吗; use `cabin-hardware-status-query`.
Do not use this skill for business mode switching such as 办公模式、放松模式、睡眠模式、个人模式; use `cabin-mode-switch`.

Only use the command names listed below. Do not invent command names such as
`seat.recline`, `seat.light.off`, `seat.health`, or `cabin.scene.boarding`.
If a passenger says 靠背/backrest/recline, use `seat.cushion --position`.

Supported customer hardware APIs:

- Seat cushion position: `seat.cushion`, query `seatNo`, `position`.
- Seat ventilation level: `seat.ventilation`, query `seatNo`, `level`.
- Seat heating level: `seat.heating`, query `seatNo`, `level`.
- Seat massage level: `seat.massage`, query `seatNo`, `level`.
- Tray table open/close: `seat.tray.open`, `seat.tray.close`, query `seatNo`.
- Reading light switch/brightness: `seat.light`, `seat.light.brightness`, query `seatNo`, `on`, `pwm`.
- Seat health collection start/stop: `seat.health.start`, `seat.health.stop`, query `seatNo`.
- Cabin ceiling light color/brightness: `cabin.ceiling.color`, query `seatNo`, `r`, `g`, `b`, `brightness`.
- Cabin ceiling light switch: `cabin.ceiling.light`, query `seatNo`, `on`.
- Cabin scene preset/clear: `cabin.scene`, `cabin.scene.clear`, query `seatNo`, `preset`.

## Required Context

Use only the server-provided `cabin_context` from the current prompt. Do not ask the passenger for seat identity unless the context is missing.

Required fields:

- `seat_no` or `seat_id`: customer hardware `seatNo` code from `cabin_context`, for example `A`, `B`, `01A`, or any site-specific value. Use the value exactly as provided. Do not pad, concatenate, normalize, or infer a different seat number.
- `column_no`: hardware side/channel, for example `A` or `B`. It may expand beyond A/B later. The current tray table API does not require it, but still pass it to the script for audit context.

## How To Execute

Call the bundled script instead of hand-writing HTTP requests. Prefer `--command`.
Pass only the command name as the `--command` value, and pass command parameters
as separate flags. For example, use `--command seat.cushion --position 30`;
do not prefer `--command "seat.cushion --position 30"`.

When using the Bash tool to run this script, set `dangerouslyDisableSandbox: true`.
The script is a server-provided hardware executor and must be allowed to reach
the configured customer control API; sandboxed Bash can block the command before
the real HTTP request is sent.

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command seat.tray.open \
  --seat-no "A" \
  --column-no "A"
```

Examples:

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command seat.tray.close \
  --seat-no "A" \
  --column-no "A"
```

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command seat.light \
  --seat-no "A" \
  --column-no "A" \
  --on true \
  --pwm 800
```

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command seat.cushion \
  --seat-no "A" \
  --column-no "A" \
  --position 30
```

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command cabin.ceiling.color \
  --seat-no "A" \
  --column-no "A" \
  --r 20 \
  --g 20 \
  --b 20 \
  --brightness 40
```

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command cabin.scene \
  --seat-no "A" \
  --column-no "A" \
  --preset boarding
```

The script reads:

- `CABIN_CONTROL_BASE_URL`
- `CABIN_CONTROL_AUTH`
- `CABIN_CONTROL_TIMEOUT_MS`
- `CABIN_CONTROL_MODE` — `execute` (default) sends the HTTP request; `emit` resolves and
  validates the command but skips the HTTP call, printing
  `{ "ok": true, "mode": "emit", "command", "seat_no", "params" }` for the server to
  execute. In a cabin session this is set to `emit`: your job is only to select and emit
  the correct command; the server performs the real dispatch and writes the reply.

## Command Mapping

- 小桌板打开/展开: `--command seat.tray.open`。例如：打开小桌板、展开桌板、把桌板支起来、把小桌子放下来、我要用餐桌、open the tray。
- 小桌板关闭/收起: `--command seat.tray.close`。例如：收起小桌板、合上桌板、把桌子收起来、桌板不用了收好、把托盘收回去、fold the tray。
- 阅读灯打开/关闭: `--command seat.light --on true|false`; if brightness is requested together, add `--pwm 0-1000`。例如：打开阅读灯、开个灯我看书、关闭阅读灯、灯太亮关掉、把灯关了、reading light on/off。
- 阅读灯调亮/调暗/设置亮度: `--command seat.light.brightness --pwm 0-1000`。`pwm=0` 最暗，`pwm=1000` 最亮。乘客未给具体数值时，按固定默认值选择：灯太刺眼/柔和一点/暗一点/不要太亮 → `--pwm 300`；正常/中等亮度 → `--pwm 500`；亮一点/看不清/调亮/再亮一些 → `--pwm 700`。例如：阅读灯调亮、把灯调暗、灯光柔和一点、亮度调到70%、灯太刺眼暗一点、再亮一些。
- 座椅靠背/坐垫位置百分比: `--command seat.cushion --position 0-100`。例如：靠背调到40%、座椅放到一半、后仰70。
- 座椅靠背/backrest/recline: always use `--command seat.cushion --position 0-100`; never use `seat.recline`。
- 放倒座椅/躺下/往后躺/后仰/调舒服一点: use `--command seat.cushion`. If the passenger does not provide a percentage, use `--position 60`。例如：放倒座椅、往后躺、把椅子放平、座椅调舒服一点、recline my seat。（注意：仅当乘客给出明确控制动作时才发射；若只是“我想躺一会/我困了/想睡”等状态表达，按状态反问处理，不要直接发射。）
- 放倒一点/后仰一点/往后调一点: use `--command seat.cushion --position 30` when no explicit percentage is provided。例如：后仰一点、往后一点点、稍微放倒、再往后调一点。
- 调直座椅/座椅归位/靠背立起来/恢复正常: use `--command seat.cushion --position 0`。例如：座椅调直、把椅子扶正、我要坐正、座椅归位、恢复正常、seat upright。
- If the passenger only says they are tired, sleepy, or uncomfortable without requesting a concrete action, ask what service they need instead of calling hardware.
- Comfort-state-only messages are not hardware commands. Do NOT emit for these exact-style messages: `这儿有点冷`, `坐着有点凉`, `有点热`, `有点闷`, `腰有点酸`, `我困了想睡会`. Ask a yes/no confirmation question first. Emit only after the passenger confirms, or when the same turn contains an explicit control action such as `打开`, `开启`, `帮我`, `给我`, `把座椅`, `开通风`, `给座椅升温`, or `帮我揉揉`.
- 座椅通风: `--command seat.ventilation --level 1-3`。硬件档位只有 1/2/3；乘客未指定档位时默认 `--level 2`（中档）；说“关闭/关掉”时用 `--level 0`。仅当乘客明确要求控制座椅通风时 emit，例如：打开座椅通风、椅子透透气、给我开通风、座椅吹风、通风开到3档、seat ventilation。若乘客只说“有点热/有点闷/屁股底下有点闷”这类状态表达，先反问是否需要开启座椅通风，不要直接 emit。
- 座椅加热: `--command seat.heating --level 1-3`。硬件档位只有 1/2/3；乘客未指定档位时默认 `--level 2`（中档）；说“关闭/关掉”时用 `--level 0`。仅当乘客明确要求控制座椅加热时 emit，例如：打开座椅加热、椅子暖一点、座椅暖一点、座椅热一点、给座椅升温、加热开到3档、seat heater。若乘客只说“这儿有点冷/坐着有点凉/有点冻”这类状态表达，先反问是否需要开启座椅加热或送毛毯，不要直接 emit。
- 座椅按摩: `--command seat.massage --level 1-3`。硬件档位只有 1/2/3；乘客未指定档位时默认 `--level 2`（中档）；说“关闭/关掉”时用 `--level 0`。仅当乘客明确要求控制座椅按摩时 emit，例如：打开座椅按摩、按摩一下、帮我揉揉、椅子给我揉揉、腰按摩、按摩强一点、按摩开到3档、seat massage。若乘客只说“腰有点酸/背有点疼/肩颈不舒服”这类状态表达，先反问是否需要开启座椅按摩，不要直接 emit。
- 生理检测开始/停止: `--command seat.health.start` or `--command seat.health.stop`。例如：开始——开始生理检测、测一下身体数据、启动健康监测、采集体征；停止——停止生理检测、别测了、关闭健康监测、结束体征采集。
- 客舱顶灯打开/关闭: `--command cabin.ceiling.light --on true|false`。例如：打开客舱顶灯、把舱灯打开、关闭顶灯、关掉客舱灯、ceiling light on/off。
- 客舱顶灯颜色亮度: `--command cabin.ceiling.color --r 0-255 --g 0-255 --b 0-255 --brightness 0-100`。RGB 表示颜色，不表示亮度；乘客说“亮度低一点/暗一点/柔和一点”时只降低 `--brightness`，不要把 RGB 改小。常用颜色固定值：暖色/warm `--r 255 --g 180 --b 80`；白色/white `255 255 255`；蓝色/blue `0 0 255`；红色/red `255 0 0`；绿色/green `0 255 0`。未给亮度时默认 `--brightness 100`；柔和/低一点/暗一点默认 `--brightness 40`。例如：顶灯调成暖色、客舱灯光柔和点、顶灯亮度调到40%、换个氛围灯颜色。
- 客舱顶灯颜色 such as 蓝色/blue: use `--command cabin.ceiling.color`, not `cabin.ceiling.light`。例如：顶灯调成蓝色、换成白色灯、把顶灯变成红色。
- 客舱场景切换: `--command cabin.scene --preset <value>`. `--preset` MUST be exactly one of the four hardware presets — no other value is valid:
  - `boarding` — 登机 / 上机。例如：切到登机场景、登机模式、登机灯光。
  - `cruise` — 巡航 / 正常。例如：巡航场景、恢复正常模式、切回常规灯光。
  - `night` — 睡眠 / 休息 / 夜间。例如：睡眠场景、休息模式、夜间模式、助眠灯光、准备睡觉、调暗休息。
  - `landing` — 下机 / 降落。例如：下机场景、降落模式、落地灯光。
  Map the passenger's words onto the closest preset (e.g. 睡眠/休息 → `night`). Never invent presets like `sleep`, `rest`, `dining`, `reading`, or `none`. 若乘客说的场景（如用餐/阅读/欢迎场景）没有对应的合法值，不要硬映射，改为追问澄清。
- 清除客舱场景: `--command cabin.scene.clear`; never approximate this as `cabin.scene --preset none`。例如：清除场景、取消场景、退出场景模式、恢复默认灯光。

## Reply Rules

- Whenever a passenger request requires hardware control, you MUST run this skill script to
  emit the correct command. Your only job is to select the command and parameters and emit
  them — you do NOT execute the hardware and you do NOT author the passenger-facing result.
- Never write any confirmation or execution wording (e.g. 已打开/已关闭/已完成/已下发…指令/
  正在为您调节). The server dispatches the hardware from your emitted command and generates
  the passenger reply from the real outcome. Any such wording you produce will be discarded.
- Do not fabricate or guess a result. If a required parameter is missing or ambiguous, ask
  the passenger to clarify instead of emitting a command with an invented value.
- For non-hardware requests (chat, inquiries) reply normally, but never claim any device was
  operated.
- Never reveal URLs, tokens, headers, raw internal logs, or implementation details to the passenger.
