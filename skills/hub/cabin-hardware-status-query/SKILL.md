---
name: cabin-hardware-status-query
displayName: 客舱硬件状态查询
description: Use this skill when a cabin passenger asks for current cabin hardware state, such as seat angle, tray table state, reading light state, comfort levels, or cabin ceiling state. The skill emits a structured query for the server to execute.
version: 1.1.0
category: 客舱服务
emoji: "🧭"
---

# Cabin Hardware Status Query

Use this skill when the passenger asks what a device's current state is. Do not use it for control requests.

The script emits a semantic mode. The server posts numeric mode (office=1, relax=2, sleep=3, personal=4), aircraftNo and seatNo to `/admin-api/cabin/broadcast/mode-seat`. It reports dispatch and delivery using the upstream response.

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
- Cabin ceiling light: `ceiling_state` uses `GET /admin-api/tcp/state/cabin/light` with the bound aircraftNo and seatNo. Read lightOpen for power, preset for effect, and r/g/b/brightness for settings.

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
