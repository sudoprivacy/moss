---
name: cabin-hardware-status-query
displayName: 客舱硬件状态查询
description: Use this skill when a cabin passenger asks for current cabin hardware state, such as seat angle, tray table state, reading light state, comfort levels, or cabin ceiling state. The skill emits a structured query for the server to execute.
version: 1.0.0
category: 客舱服务
emoji: "🧭"
---

# Cabin Hardware Status Query

Use this skill when the passenger asks what a device's current state is. Do not use it for control requests.

The script only emits a structured query. The server calls the real hardware status API and asks the model to phrase the passenger reply from the real result.

## Query Shape

Call the bundled script with:

- `--target-type seat|cabin`
- `--status-key <key>`
- `--seat-no` from `cabin_context.seat_no` for seat status

Supported status keys:

- Seat posture / angle: `posture`
- Tray table: `tray`
- Seat safety: `safety`
- Seat comfort levels: `comfort`
- Reading light: `reading_light`
- Cabin glass: `glass_state`
- Cabin ceiling light: `ceiling_state`

## Examples

```bash
node .nexus/sudocode/skills/cabin-hardware-status-query/scripts/cabin-status.mjs \
  --target-type seat \
  --status-key posture \
  --seat-no "A"
```

```bash
node .nexus/sudocode/skills/cabin-hardware-status-query/scripts/cabin-status.mjs \
  --target-type seat \
  --status-key tray \
  --seat-no "A"
```

```bash
node .nexus/sudocode/skills/cabin-hardware-status-query/scripts/cabin-status.mjs \
  --target-type cabin \
  --status-key ceiling_state
```

## Rules

- If the passenger asks "当前座椅角度是多少", emit `target-type seat`, `status-key posture`.
- If the passenger asks whether the tray is open, closed, folded, unfolded, or put away, emit `target-type seat`, `status-key tray`.
- If the passenger asks reading light state or brightness, emit `target-type seat`, `status-key reading_light`.
- If the passenger asks seat heating, ventilation, or massage level, emit `target-type seat`, `status-key comfort`.
- If the passenger asks top light state/color/brightness, emit `target-type cabin`, `status-key ceiling_state`.
- Never turn a status question into a control command.
- After emitting, stop. Do not write a passenger-facing answer yourself.
