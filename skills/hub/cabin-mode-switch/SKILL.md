---
name: cabin-mode-switch
displayName: 客舱模式切换
description: Use this skill when a cabin passenger asks to switch the tablet/business cabin mode to office, relax, sleep, or personal. The skill emits a structured mode switch for the server to call the business broadcast API.
version: 1.0.0
category: 客舱服务
emoji: "🛋️"
---

# Cabin Mode Switch

Use this skill when the passenger asks to switch cabin business mode. This is not the same as hardware scene control.

The script only emits a structured request. The server calls `POST /admin-api/cabin/broadcast/mode-seat` and writes the passenger reply from the real result.

Supported modes:

- `office` - 办公模式 / 工作模式
- `relax` - 放松模式 / 休闲模式
- `sleep` - 睡眠模式 / 睡觉模式
- `personal` - 个人模式 / 私人模式

## How To Execute

Use `cabin_context.aircraft_no` and `cabin_context.seat_no` exactly as provided.

```bash
node .nexus/sudocode/skills/cabin-mode-switch/scripts/cabin-mode.mjs \
  --mode sleep \
  --title 睡眠模式 \
  --aircraft-no "B-WITHFLIGHT-01" \
  --seat-no "A"
```

## Rules

- "切换到睡眠模式" -> `--mode sleep --title 睡眠模式`
- "我要办公模式" -> `--mode office --title 办公模式`
- "切到放松模式" -> `--mode relax --title 放松模式`
- "个人模式" -> `--mode personal --title 个人模式`
- Do not use `cabin.scene` for these four business modes.
- After emitting, stop. Do not write a passenger-facing answer yourself.
