# Native input recovery

The existing ACP bridge advertises `nativeInputReceipts: { version: 1 }` in its
application hello. The runner replays that hello through its ordinary attached
channel. A consumer must check this capability before sending a receipt control;
it must not send an unknown control to an older bridge as ordinary model input.
Native input admission still requires the engine's existing input-delivery v1
capability. Neither a runner `stdin_ack` nor an admission reply proves completion.

An input keeps its stable `clientId` as the ordinary user message UUID. After
native consumption, the transcript also records its native session and turn
identity. Assistant records and the final `native_input_complete` result refer
to that same identity. The completion marker flushes the ordered transcript to
disk before `input_delivery_persisted` is emitted. Earlier transcript write
failures prevent a successful marker. Streamed output remains responsive while
these existing background writes complete.

To inspect an existing input on the owning runner, send the ordinary stdin
envelope containing:

```json
{"type":"control_request","request_id":"correlation-id","request":{"subtype":"input_receipt","clientId":"stable-input-id"}}
```

The bridge emits `input_delivery_receipt` with the same request ID. Its receipt
is `pending`, `complete` with the original assistant text and optional
`TURN_CANCELLED`/`TURN_FAILED`, or `unknown`. Reads use the ordinary transcript,
not a separate answer or execution store. A replacement bridge can recover
completed work even if its native execution has changed. Pending status requires
the current native queue or running turn; a consumed but incomplete turn from a
different execution is unknown. Legacy transcripts without the native identity
and completion marker are unknown too. Adjacent messages never establish that
an input completed.

Callers use the existing authorized internal session channel, which routes to
the current owner. They must enforce current project and actor authorization
before and after recovery. The SQL review dispatch reservation remains separate:
an unknown result cannot release it or trigger another input submission. This
protocol alone does not activate public review routing or a cloud comment provider.
