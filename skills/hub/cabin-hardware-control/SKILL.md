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

- 小桌板打开/展开: `--command seat.tray.open`
- 小桌板关闭/收起: `--command seat.tray.close`
- 阅读灯打开/关闭: `--command seat.light --on true|false`; if brightness is requested together, add `--pwm 0-1000`.
- 阅读灯调亮/调暗/设置亮度: `--command seat.light.brightness --pwm 0-1000`.
- 座椅靠背/坐垫位置百分比: `--command seat.cushion --position 0-100`.
- 座椅靠背/backrest/recline: always use `--command seat.cushion --position 0-100`; never use `seat.recline`.
- 放倒座椅/躺下/往后躺/后仰/调舒服一点: use `--command seat.cushion`. If the passenger does not provide a percentage, use `--position 60`.
- 放倒一点/后仰一点/往后调一点: use `--command seat.cushion --position 30` when no explicit percentage is provided.
- 调直座椅/座椅归位/靠背立起来/恢复正常: use `--command seat.cushion --position 0`.
- If the passenger only says they are tired, sleepy, or uncomfortable without requesting a concrete action, ask what service they need instead of calling hardware.
- 座椅通风: `--command seat.ventilation --level 0-10`.
- 座椅加热: `--command seat.heating --level 0-10`.
- 座椅按摩: `--command seat.massage --level 0-10`.
- 生理检测开始/停止: `--command seat.health.start` or `--command seat.health.stop`.
- 客舱顶灯打开/关闭: `--command cabin.ceiling.light --on true|false`.
- 客舱顶灯颜色亮度: `--command cabin.ceiling.color --r 0-255 --g 0-255 --b 0-255 --brightness 0-100`.
- 客舱顶灯颜色 such as 蓝色/blue: use `--command cabin.ceiling.color`, not `cabin.ceiling.light`.
- 客舱场景切换: `--command cabin.scene --preset <value>`. `--preset` MUST be exactly one of the four hardware presets — no other value is valid:
  - `boarding` — 登机 / 上机
  - `cruise` — 巡航 / 正常
  - `night` — 睡眠 / 休息 / 夜间
  - `landing` — 下机 / 降落
  Map the passenger's words onto the closest preset (e.g. 睡眠/休息 → `night`). Never invent presets like `sleep`, `rest`, `dining`, `reading`, or `none`.
- 清除客舱场景: `--command cabin.scene.clear`; never approximate this as `cabin.scene --preset none`.

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
