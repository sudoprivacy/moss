---
name: cabin-mode-switch
displayName: 客舱模式切换
description: Use this skill when a cabin passenger asks to switch the tablet/business cabin mode to office, relax, sleep, or personal. The skill emits a structured mode switch for the server to call the business broadcast API.
version: 1.0.1
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

- Trigger this skill for requests that combine a control verb with one of the four business modes:
  - 打开/开启/切换/调整/调至/进入/启动 + 办公模式/工作模式 -> `--mode office --title 办公模式`
  - 打开/开启/切换/调整/调至/进入/启动 + 放松模式/休闲模式 -> `--mode relax --title 放松模式`
  - 打开/开启/切换/调整/调至/进入/启动 + 睡眠模式/睡觉模式 -> `--mode sleep --title 睡眠模式`
  - 打开/开启/切换/调整/调至/进入/启动 + 个人模式/私人模式 -> `--mode personal --title 个人模式`
- Treat these exact-style requests as mode switches:
  - "帮我打开办公模式。"
  - "帮我切换到办公模式。"
  - "帮我调整至办公模式。"
  - "开启办公模式。"
  - "帮我打开放松模式。"
  - "进入睡眠模式。"
  - "切到个人模式。"
- Do not use `cabin.scene` for these four business modes. Never map 办公模式 to `cruise`, 睡眠模式 to `night`, 放松模式 to a scene preset, or 个人模式 to any hardware scene.
- Do not use `cabin-hardware-control` for these four business modes.
- After emitting, stop. Do not write a passenger-facing answer yourself.
- If a tool or filesystem attempt fails, do not reveal the failure. Never output words such as `sandbox`, `filesystem`, `Let me try`, `skill`, `tool`, `接口`, `服务端将为您处理`, or script paths to the passenger.

## Non-Triggers

- Questions about a mode are not switch requests. "办公模式是什么？", "办公模式的定义是什么？", or "办公模式有什么区别？" should be answered briefly in natural language and should not call this skill.
- Hardware scenes are separate. "切到巡航场景", "夜间场景", "登机场景", or "降落场景" belongs to hardware scene control, not this skill.

## Forbidden Examples

- Passenger: "帮我调整至办公模式。"
  - Wrong: `cabin.scene --preset cruise`
  - Correct: `cabin-mode.mjs --mode office --title 办公模式 ...`
- Passenger: "帮我打开睡眠模式。"
  - Wrong: `cabin.scene --preset night`
  - Correct: `cabin-mode.mjs --mode sleep --title 睡眠模式 ...`
- Passenger: "帮我打开放松模式。"
  - Wrong: reply "请问还有什么可以帮您的吗？"
  - Correct: emit `--mode relax --title 放松模式`, then stop.
