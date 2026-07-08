# Cabin Health Report Collection Design

Date: 2026-07-07
Status: Draft for review

## 1. Summary

Add a cabin health report workflow for Pad-triggered physiological detection.

The Pad starts the hardware-side physiological detection itself, then calls Moss to open a 30 second server-side collection window. Moss listens to the existing cabin WebSocket stream, filters `telemetry` messages for `topic=health` and the current seat, aggregates valid samples, computes average health metrics and deterministic levels, asks the model to generate passenger-facing analysis text, stores the completed report, and exposes a polling API for the Pad to retrieve report data.

Moss does not call the external health start/stop hardware endpoints for this workflow.

## 2. Goals

- Provide a start API that immediately returns `report_id` and `collecting` status.
- Collect 30 seconds of `telemetry.topic=health` samples from the existing WS connection.
- Support multiple seats collecting at the same time, separated by `seatNo`.
- Compute average values for heart rate, respiratory rate, SpO2, and body temperature.
- Classify each metric with stable enums for Pad rendering.
- Generate and store a structured report payload that the Pad can poll and render.
- Keep core report fields deterministic; use the model only for controlled narrative text.
- Reuse existing cabin token/tablet context for seat identity and access control.

## 3. Non-Goals

- Do not trigger hardware collection start or stop from Moss for this workflow.
- Do not stream partial samples to the Pad.
- Do not let the model decide metric levels, score, or numeric values.
- Do not provide medical diagnosis. The report is an auxiliary cabin health prompt only.
- Do not replace the existing chat hardware command route for `seat.health.start` or `seat.health.stop`.

## 4. Existing Context

Relevant current code:

- `src/server/cabin/api.ts`: cabin Pad APIs, token validation, context resolution, SSE chat routes.
- `src/server/cabin/store.ts`: SQLite-backed cabin tables.
- `src/server/cabin/types.ts`: cabin domain types.
- `src/server/cabin/automation.ts`: existing WS client that currently consumes only `type=flight_data`.
- `src/server/cabin/service.ts`: hardware command routing and LLM helpers.

Relevant external WS message shape:

```json
{
  "type": "telemetry",
  "content": {
    "topic": "health",
    "title": "seat",
    "seatNo": "B",
    "message": {
      "online": true,
      "collecting": true,
      "frame_count": 10,
      "heart_rate": 72,
      "spo2": 98,
      "respiratory_rate": 16,
      "body_temperature": 36.5
    }
  }
}
```

The Apifox examples sometimes show `content` as an object and sometimes describe `content` as JSON that must be decoded. The parser must accept both:

- `content` as an object.
- `content` as a JSON string.

## 5. High-Level Flow

```text
Pad starts hardware health collection
-> Pad calls POST /v1/health-reports/start
-> Moss resolves cabin token and seat context
-> Moss creates a health report row with status=collecting
-> Moss registers active collection window by seatNo
-> Existing WS receives telemetry.health samples
-> Moss routes samples to matching active report by seatNo
-> After 30 seconds, Moss finalizes report
-> Moss computes averages, levels, score, and deterministic summary fields
-> Moss calls model to generate overview, interpretations, suggestions
-> Moss stores final report JSON with status=completed
-> Pad polls GET /v1/health-reports/{report_id}
```

## 6. API Design

All APIs use existing cabin Pad auth:

- `Authorization: Bearer <cabin access token>`
- `X-Cabin-Tablet-Token`
- `X-Cabin-Tablet-Id`

### 6.1 Start Health Report

`POST /v1/health-reports/start`

Request body:

```json
{
  "language": "zh"
}
```

All fields are optional for v1. Seat identity comes from the cabin token/context, not from request body.

Successful response:

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "collecting",
  "collect_duration_seconds": 30,
  "started_at": 1783420000000,
  "estimated_completed_at": 1783420030000
}
```

Every start request creates a new report. If the same seat already has an unfinished `collecting` or `generating` report, Moss marks the old report as `cancelled` with `error_code=SUPERSEDED_BY_NEW_REPORT`, removes it from the active collection map, and only the new report receives subsequent WS samples.

Rationale: the server does not need to infer whether the Pad is recovering a closed page or starting over. `POST /v1/health-reports/start` always means "begin a new collection window", and the newest report wins for that seat.

### 6.2 Get Health Report

`GET /v1/health-reports/{report_id}`

Collecting response:

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "collecting",
  "seat_no": "B",
  "progress": {
    "duration_seconds": 30,
    "elapsed_seconds": 12,
    "sample_count": 8
  },
  "started_at": 1783420000000,
  "estimated_completed_at": 1783420030000
}
```

Generating response:

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "generating",
  "seat_no": "B",
  "progress": {
    "duration_seconds": 30,
    "elapsed_seconds": 30,
    "sample_count": 26
  },
  "started_at": 1783420000000,
  "estimated_completed_at": 1783420030000
}
```

Completed response:

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "completed",
  "seat_no": "B",
  "flight_id": "CA1234",
  "flight_date": "2026-07-07",
  "generated_at": 1783420031000,
  "sample_count": 26,
  "metrics": {
    "heart_rate": {
      "unit": "bpm",
      "value": 120,
      "level": "high",
      "range": {
        "min": 20,
        "max": 180,
        "normal_min": 60,
        "normal_max": 100
      }
    },
    "respiratory_rate": {
      "unit": "breaths_per_min",
      "value": 22,
      "level": "high",
      "range": {
        "min": 6,
        "max": 30,
        "normal_min": 16,
        "normal_max": 20
      }
    },
    "spo2": {
      "unit": "percent",
      "value": 94,
      "level": "low",
      "range": {
        "min": 80,
        "max": 110,
        "normal_min": 95,
        "normal_max": 100
      }
    },
    "body_temperature": {
      "unit": "celsius",
      "value": 37.8,
      "level": "high",
      "range": {
        "min": 20,
        "max": 45,
        "normal_min": 36.1,
        "normal_max": 37.2
      }
    }
  },
  "summary": {
    "score": 76.5,
    "score_level": "pass",
    "emotion_status": "failed",
    "physiology_status": "abnormal",
    "metric_levels": {
      "heart_rate": "high",
      "respiratory_rate": "high",
      "spo2": "low",
      "body_temperature": "high"
    },
    "overview": "心率、呼吸率偏快，血氧饱和度偏低，体温偏高。",
    "interpretations": [
      "心率 120 bpm，偏快。",
      "呼吸率 22 次/分钟，偏快。",
      "血氧饱和度 94%，偏低。",
      "体温 37.8°C，偏高。"
    ],
    "suggestions": [
      "建议先静坐休息 5-10 分钟后重新测量。",
      "如持续不适或指标继续异常，请联系乘务人员。"
    ],
    "disclaimer": "本报告仅用于客舱健康状态辅助提示，不作为医疗诊断依据。"
  }
}
```

Failed response:

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "failed",
  "seat_no": "B",
  "error_code": "INSUFFICIENT_SAMPLES",
  "error_message": "未采集到足够的有效生理检测数据，请重新检测。",
  "sample_count": 0
}
```

Cancelled response:

```json
{
  "status": "ok",
  "report_id": "hr_old",
  "report_status": "cancelled",
  "seat_no": "B",
  "error_code": "SUPERSEDED_BY_NEW_REPORT",
  "error_message": "已开始新的检测，本次检测已取消。",
  "sample_count": 8
}
```

There is no `latest` API in v1. Pad should keep and poll the `report_id` returned by each start call. If Pad starts again, it receives a new `report_id`.

## 7. Enums

### 7.1 Report Status

```text
collecting
generating
completed
failed
cancelled
expired
```

Meanings:

- `collecting`: 30 second sample window is open.
- `generating`: sample window closed; averages are computed; model text is being generated.
- `completed`: final report is available.
- `failed`: collection or report generation failed.
- `cancelled`: a newer start request for the same seat superseded this report.
- `expired`: reserved for future retention rules.

### 7.2 Metric Level

```text
low
normal
high
invalid
missing
```

The report does not return a numeric level code. Pad should render directly from the `level` enum to avoid conflicting duplicated state.

### 7.3 Score Level

```text
good
pass
fail
```

Customer scoring mapping:

```text
80-100 good
60-79  pass
0-59   fail
```

The total score follows the customer health scoring document: SpO2 contributes 40%, heart rate 30%, respiratory rate 15%, and body temperature 15%. Each metric is scored with the customer-provided segmented quadratic function across normal, warning, and danger zones before weighting. Red-line caps are applied after weighting: SpO2 `< 90` caps the final score at 30; heart rate `> 150` or `< 40` caps the final score at 35.

### 7.4 Summary Status

`physiology_status`:

```text
normal
abnormal
unknown
```

`emotion_status`:

```text
passed
warning
failed
unknown
```

For v1, `emotion_status` is derived from physiological score only because no independent emotion signal is available:

- `passed` when score >= 75.
- `warning` when score >= 60 and score < 75.
- `failed` when score < 60.
- `unknown` when report has insufficient valid data.

## 8. Metric Rules

The report uses these configured metric bands:

| Metric | Low | Normal | High | Valid Range |
| --- | --- | --- | --- | --- |
| `heart_rate` | `[20, 60)` | `[60, 100]` | `(100, 180]` | `[20, 180]` |
| `respiratory_rate` | `[6, 16)` | `[16, 20]` | `(20, 30]` | `[6, 30]` |
| `spo2` | `[80, 95)` | `[95, 100]` | `(100, 110]` | `[80, 110]` |
| `body_temperature` | `[20, 36.1)` | `[36.1, 37.2]` | `(37.2, 45]` | `[20, 45]` |

Values outside the valid range are ignored for averages. If a metric has no valid samples, return `level=missing` and set `value=null`.

Rounding:

- `heart_rate`: nearest integer.
- `respiratory_rate`: nearest integer.
- `spo2`: nearest integer.
- `body_temperature`: one decimal place.

## 9. Score Rules

The score is deterministic and computed before model generation.

Use the v1 soft-penalty algorithm so the score style matches the provided Pad screenshot:

- Start at 100.
- Each `low` or `high` metric subtracts 10.
- Each `missing` or `invalid` metric subtracts 20.
- Additional penalty: if `spo2=low`, subtract 5.
- Clamp final score to `[0, 100]`.

Examples:

- All metrics normal: 100.
- Heart rate high only: 90.
- Heart rate high, respiratory rate high, SpO2 low, body temperature high: `100 - 10*4 - 5 = 55`.

## 10. Data Model

Add a new SQLite table: `cabin_health_reports`.

Suggested schema:

```sql
CREATE TABLE IF NOT EXISTS cabin_health_reports (
  id TEXT PRIMARY KEY,
  aircraft_no TEXT,
  flight_id TEXT NOT NULL,
  flight_date TEXT NOT NULL,
  seat_no TEXT NOT NULL,
  tablet_id TEXT,
  passenger_id TEXT,
  passenger_ref TEXT,
  status TEXT NOT NULL,
  language TEXT,
  sample_count INTEGER NOT NULL DEFAULT 0,
  samples_json TEXT,
  metrics_json TEXT,
  summary_json TEXT,
  error_code TEXT,
  error_message TEXT,
  cancelled_at INTEGER,
  started_at INTEGER NOT NULL,
  collect_until INTEGER NOT NULL,
  generated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cabin_health_reports_seat_status
  ON cabin_health_reports(flight_id, flight_date, seat_no, status);

CREATE INDEX IF NOT EXISTS idx_cabin_health_reports_created
  ON cabin_health_reports(created_at);
```

Only store accepted normalized samples in `samples_json`. Raw WS payloads should go to logs if needed, not into the report row.

Sample stored shape:

```json
[
  {
    "received_at": 1783420001000,
    "frame_count": 10,
    "heart_rate": 72,
    "spo2": 98,
    "respiratory_rate": 16,
    "body_temperature": 36.5
  }
]
```

## 11. Runtime Service Design

Add a focused service:

`src/server/cabin/healthReports.ts`

Responsibilities:

- `startReport(context, options)`: cancel unfinished reports for the seat, then create a new active report.
- `handleTelemetry(envelope)`: parse WS `telemetry.health`, route sample to active report by `seatNo`.
- `finalizeReport(reportId)`: compute averages, levels, score, model text, and persist report.
- `getReport(reportId, context)`: enforce Pad access control and return API payload.

The service should own the in-memory active map:

```text
activeReportsBySeatNo:
  B -> {
    reportId,
    seatNo,
    flightId,
    flightDate,
    collectUntil,
    samples,
    timer
  }
```

Routing rule:

- WS sample `seatNo` must match an active report `seatNo`.
- The report must still be `collecting`.
- If no active report exists, ignore the sample.

Concurrency rule:

- One active `collecting` or `generating` report per `(flight_id, flight_date, seat_no)`.
- A new start request cancels any unfinished report for that seat before creating the new report.
- Cancelled reports stay queryable by `report_id`, but they no longer receive WS samples or generate a final report.

## 12. WS Integration

The current `CabinFlightAutomation` owns a WS connection and ignores non-`flight_data` messages. Health reports need `telemetry.health` from the same WS.

Recommended refactor:

- Extract WS connection and envelope parsing into a shared `CabinWsSubscriber`.
- `CabinWsSubscriber` connects to `cabin.flightStateWsUrl`.
- It parses raw messages once and dispatches envelopes to registered handlers.
- `CabinFlightAutomation` registers a `flight_data` handler.
- `CabinHealthReportService` registers a `telemetry.health` handler.

This avoids opening two WS connections to the same external service and keeps message parsing consistent.

Minimal alternative:

- Extend `CabinFlightAutomation` constructor to accept an optional health report service and call it before ignoring non-`flight_data`.

Recommendation: use the shared subscriber if implementation time allows. If time is tight, the minimal alternative is acceptable for v1, but name the extraction as a follow-up.

WS parser requirements:

- Accept `content` object or JSON string.
- Ignore malformed messages after logging.
- For `telemetry.health`, require `seatNo` and `message`.
- Numeric fields may be number or numeric string.
- Boolean fields may be boolean or string.

## 13. Model Generation

The model should generate only:

- `overview`
- `interpretations`
- `suggestions`

The model must not change:

- metric values
- metric levels
- score
- status enums
- units

Prompt input should include the deterministic computed payload:

```json
{
  "metrics": {
    "heart_rate": { "value": 120, "level": "high", "unit": "bpm" },
    "respiratory_rate": { "value": 22, "level": "high", "unit": "breaths_per_min" },
    "spo2": { "value": 94, "level": "low", "unit": "percent" },
    "body_temperature": { "value": 37.8, "level": "high", "unit": "celsius" }
  },
  "score": 76.5,
  "language": "zh"
}
```

Prompt constraints:

- Output strict JSON.
- No Markdown.
- No diagnosis.
- Use concise passenger-friendly Chinese.
- Include disclaimer.
- If severe or sustained abnormal values are present, advise contacting cabin crew.

Fallback:

- If model call fails or returns invalid JSON, create deterministic template text.
- The report should still complete unless there are insufficient samples.

## 14. Error Handling

Start API errors:

- `401 MISSING_AUTHORIZATION`
- `403 INVALID_AUTHORIZATION`
- `400 MISSING_SEAT_CONTEXT`
- `500 HEALTH_REPORT_START_FAILED`

Get API errors:

- `404 HEALTH_REPORT_NOT_FOUND`
- `403 HEALTH_REPORT_FORBIDDEN`
- `500 HEALTH_REPORT_READ_FAILED`

Report failure states:

- `INSUFFICIENT_SAMPLES`: no valid samples or below minimum sample threshold.
- `WS_NOT_CONFIGURED`: no WS URL configured and no sample source available.
- `REPORT_GENERATION_FAILED`: unexpected finalization failure.

Minimum sample threshold:

- Recommended: at least 1 valid sample for v1, because sample frequency is not yet guaranteed.
- If external WS sends high-frequency data, raise to 5 samples later.

## 15. Access Control

Pad can only access reports for its own seat context.

On start:

- Derive `seat_no`, `flight_id`, `flight_date`, `tablet_id`, passenger identifiers from cabin token/context.
- Do not trust `seat_no` from request body.

On get:

- Verify report `seat_no` equals current context seat.
- Verify `flight_id` and `flight_date` match when available.
- If the current context is incomplete, require matching `tablet_id`.

## 16. Logging and Observability

Use existing `CabinLogger` style.

Log events:

- `health_report.start`
- `health_report.cancel_previous`
- `health_report.sample.accepted`
- `health_report.sample.ignored`
- `health_report.finalize.start`
- `health_report.finalize.completed`
- `health_report.finalize.failed`
- `health_report.model.request`
- `health_report.model.response`
- `health_report.model.fallback`

Common log fields:

| Field | Description |
| --- | --- |
| `request_id` | HTTP request id for Pad API calls, or generated WS/finalize id for background work. |
| `report_id` | Health report id. This is the primary correlation key for Pad-side troubleshooting. |
| `previous_report_id` | Old report id when a new start cancels an unfinished report. |
| `tablet_id` | Pad tablet id from request headers. |
| `seat_no` | Seat number used for WS sample routing. |
| `flight_id` / `flight_date` | Flight scope resolved from cabin context. |
| `report_status` | Report status after the event. |
| `sample_count` | Number of accepted samples currently attached to the report. |
| `ignored_reason` | Why a WS sample was ignored, such as `no_active_report`, `seat_mismatch`, `invalid_topic`, `invalid_metric`, or `report_not_collecting`. |
| `elapsed_ms` | Upstream/model/finalization duration where relevant. |
| `model` | LLM model used for report text generation. |

Event details:

- `health_report.start`: log every Pad start request, including newly created `report_id`, seat, tablet, flight, collection duration, and estimated completion.
- `health_report.cancel_previous`: log when a new start cancels an unfinished report for the same seat, including `previous_report_id`, new `report_id`, old status, old sample count, and `error_code=SUPERSEDED_BY_NEW_REPORT`.
- `health_report.sample.accepted`: log accepted WS samples at a throttled cadence, for example first sample and every 10th sample, with metric presence flags and `sample_count`.
- `health_report.sample.ignored`: log ignored WS samples with `ignored_reason`; throttle repeated noisy reasons by seat/topic.
- `health_report.finalize.start`: log when the 30 second timer closes and final aggregation begins.
- `health_report.finalize.completed`: log final sample count, metric levels, score, and whether model text came from LLM or fallback.
- `health_report.finalize.failed`: log failure reason and error code.
- `health_report.model.request`: log model request metadata, not raw prompt if it contains passenger-sensitive context.
- `health_report.model.response`: log model status, elapsed time, and whether returned JSON was valid.
- `health_report.model.fallback`: log when deterministic template text is used.

Avoid logging high-volume raw physiological values by default. For sample logs, include counters and metric presence, not every raw value, unless an explicit debug mode is enabled for onsite troubleshooting.

## 17. Configuration

Add optional cabin config:

```json
{
  "cabin": {
    "healthReportEnabled": true,
    "healthReportCollectSeconds": 30,
    "healthReportMinSamples": 1
  }
}
```

Environment variables:

```text
CABIN_HEALTH_REPORT_ENABLED=true
CABIN_HEALTH_REPORT_COLLECT_SECONDS=30
CABIN_HEALTH_REPORT_MIN_SAMPLES=1
```

Default recommendation:

- `healthReportEnabled`: false in generic deployments, true in cabin integration config.
- `healthReportCollectSeconds`: 30.
- `healthReportMinSamples`: 1.

## 18. Testing Plan

Unit tests:

- Parses `telemetry.health` with object content.
- Parses `telemetry.health` with string content.
- Ignores non-health telemetry.
- Ignores health telemetry for seats without active reports.
- Routes simultaneous seat A and seat B samples to separate reports.
- New start for same seat cancels the previous unfinished report and creates a new report.
- Cancelled reports no longer receive samples.
- Cancelled reports remain queryable by `report_id`.
- Computes averages and rounds correctly.
- Classifies boundary values correctly.
- Produces `missing` for absent metrics.
- Computes score with the v1 soft penalty rules.
- Falls back to template text when model output is invalid.

API tests:

- `POST /v1/health-reports/start` returns collecting report.
- `GET /v1/health-reports/{id}` returns collecting progress.
- Completed report response matches the Pad rendering contract.
- Cross-seat report access is forbidden.
- No valid samples marks report failed with `INSUFFICIENT_SAMPLES`.

Integration/mock tests:

- Extend `scripts/cabin-mock-backend.mjs` to emit `telemetry.health` samples for multiple seats.
- Verify Pad-style start -> WS samples -> completed report -> get report flow.

## 19. Rollout Plan

1. Add DB schema and types.
2. Add `CabinHealthReportService` with deterministic aggregation and report formatting.
3. Wire start/get APIs under `/v1/health-reports`.
4. Wire WS telemetry handling.
5. Add model generation with fallback.
6. Extend mock backend and tests.
7. Document API examples for Pad integration.

## 20. Decisions and Follow-Up Confirmations

Resolved:

- Moss does not trigger hardware health start/stop for this Pad workflow.
- Start API returns immediately with `report_id`.
- Pad polls a get API for final report.
- Concurrent users are separated by WS `seatNo`.
- Same seat can have only one active report at a time; new start cancels old unfinished report.
- Report response uses English field names and stable enums.
- Score uses the v1 soft-penalty algorithm.

Confirm during implementation:

- Exact Pad route names expected by frontend.
- Whether `flight_id/flight_date` should be strict on report get when current passenger context changes mid-flight.
- Whether `emotion_status` should remain derived from health score or be removed until there is a real emotion signal.
