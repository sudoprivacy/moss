---
name: cabin-hardware-control
displayName: 客舱硬件控制
description: Use this skill when a cabin passenger asks to control real cabin hardware, especially opening or closing the tray table, seat-side devices, lights, seat posture, or other equipment through customer cabin control APIs. The skill must use server-provided cabin_context for seat identity.
version: 1.1.0
category: 客舱服务
emoji: "🛫"
---

# Cabin Hardware Control

Use this skill for passenger requests that require real cabin hardware control.

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

- `seat_id` or `seat_no`: passenger seat number, for example `01A`.
- `column_no`: hardware side/channel, for example `A` or `B`. It may expand beyond A/B later. The current tray table API does not require it, but still pass it to the script for audit context.

## How To Execute

Call the bundled script instead of hand-writing HTTP requests. Prefer `--command`.

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command seat.tray.open \
  --seat-no "01A" \
  --column-no "B"
```

Examples:

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command seat.tray.close \
  --seat-no "01A" \
  --column-no "B"
```

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command seat.light \
  --seat-no "01A" \
  --column-no "B" \
  --on true \
  --pwm 80
```

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command seat.cushion \
  --seat-no "01A" \
  --column-no "B" \
  --position 30
```

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command cabin.ceiling.color \
  --seat-no "01A" \
  --column-no "B" \
  --r 20 \
  --g 20 \
  --b 20 \
  --brightness 40
```

```bash
node .nexus/sudocode/skills/cabin-hardware-control/scripts/cabin-control.mjs \
  --command cabin.scene \
  --seat-no "01A" \
  --column-no "B" \
  --preset boarding
```

The script reads:

- `CABIN_CONTROL_BASE_URL`
- `CABIN_CONTROL_AUTH`
- `CABIN_CONTROL_TIMEOUT_MS`

## Command Mapping

- 小桌板打开/展开: `--command seat.tray.open`
- 小桌板关闭/收起: `--command seat.tray.close`
- 阅读灯打开/关闭: `--command seat.light --on true|false`; if brightness is requested together, add `--pwm 0-100`.
- 阅读灯调亮/调暗/设置亮度: `--command seat.light.brightness --pwm 0-100`.
- 座椅靠背/坐垫位置百分比: `--command seat.cushion --position 0-100`.
- 座椅通风: `--command seat.ventilation --level 0-10`.
- 座椅加热: `--command seat.heating --level 0-10`.
- 座椅按摩: `--command seat.massage --level 0-10`.
- 生理检测开始/停止: `--command seat.health.start` or `--command seat.health.stop`.
- 客舱顶灯打开/关闭: `--command cabin.ceiling.light --on true|false`.
- 客舱顶灯颜色亮度: `--command cabin.ceiling.color --r 0-255 --g 0-255 --b 0-255 --brightness 0-100`.
- 客舱场景切换: `--command cabin.scene --preset boarding`; use the preset named by the user when provided.
- 清除客舱场景: `--command cabin.scene.clear`.

## Reply Rules

- If the script returns `"ok": true` and `"execution_status": "accepted"`, tell the passenger the command has been issued and the device is being adjusted. Do not say the action has completed.
- Prefer the script's `"passenger_reply_hint"` when present.
- Only say the hardware action is completed when the script returns `"execution_status": "completed"`.
- If the script returns `"ok": false`, do not claim success. Apologize briefly and say the request has not completed.
- Never reveal URLs, tokens, headers, raw internal logs, or implementation details to the passenger.
