# Findings

## Existing implementation

- `CabinFlightAutomation.checkSeat()` currently checks safety, posture, and tray only.
- Automatic controls currently include `seat.cushion(position=0)` and `seat.tray.close` only.
- Passenger-path tray close already checks `tray_flipped`, but flight automation checks only `tray_state`.
- Phase code 1 maps to `taxi_in`; code 15 maps to `landing_approach`, so both phases enter automation, but no baggage rule exists.
- `CabinBroadcastClient` already supports `audio-all` and `error-seat` with configured Authorization and hardware API key.
- The plan document specifies baggage status key `bag`, fields `higherBag`, `lowerBag`, and `bagLock`, accepting booleans and string booleans.

## Required implementation

- Add bag status query and rules: phase 1 with `bagLock=false` -> lock warning; phase 15 with either bag layer true -> take-away warning.
- Add automatic reading light and cabin ceiling status checks and controls during safety phases.
- Add tray protection: if `tray_flipped=true`, emit alert and skip close command; only close when safe and not already closed.
- Add deduplication so repeated WebSocket messages/reconnects do not repeatedly push the same phase/seat/alert type.

## Implemented and verified

- `checkSeat()` queries `key=bag` for phase codes 1 and 15. Phase 1 checks `bagLock`; phase 15 checks `higherBag` and `lowerBag`. Boolean and string boolean values are accepted; missing or failed status responses are treated as status failures without making up an alert.
- Safety phases query `reading_light` per seat and `ceiling_state` once for the cabin. They issue `seat/light?on=false` and `cabin/ceiling/light?on=false` only when the current state is on.
- Seat, tray, reading-light, and ceiling-light controls perform one post-control status check. A mismatch or failed status query creates `HARDWARE_STATE_NOT_REACHED`.
- Automation tray close requires both `tray_state` and `tray_flipped`; an unfolded tray creates `TRAY_NOT_FOLDED` and never receives the close command.
- Added local simulated endpoint tests for baggage rules, tray protection, reading/ceiling controls, post-control verification, and missing-field handling.
