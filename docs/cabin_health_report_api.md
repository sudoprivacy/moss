# 客舱生理检测报告接口文档

更新时间：2026-07-07

本文档面向 Pad 端和现场联调方，说明 Pad 点击开始生理检测后，如何通知 Moss 开启 30 秒数据采集，以及如何轮询获取检测报告数据。

## 1. 交互流程

```text
1. Pad 自行启动硬件生理检测采集
2. Pad 调用 Moss 开始报告接口
3. Moss 立即返回 report_id，状态为 collecting
4. Moss 在已有 WebSocket 连接中接收 30 秒 telemetry.health 数据
5. Moss 按 seatNo 匹配当前报告，计算平均值和指标等级
6. Moss 生成智能分析报告
7. Pad 使用 report_id 轮询获取报告接口
8. 报告 completed 后，Pad 根据返回 JSON 自行渲染页面
```

Moss 不会调用硬件的生理检测 start/stop 接口。本流程只负责服务端接收 WS 生理数据、聚合和生成报告。

## 2. 鉴权

所有接口沿用现有 cabin Pad 鉴权。

请求头：

```http
Authorization: Bearer <cabin access token>
X-Cabin-Tablet-Token: <tablet token>
X-Cabin-Tablet-Id: <tablet id>
Content-Type: application/json
```

座位号由 token/context 解析得到，Pad 不需要在请求体里传 `seatNo`，服务端也不会信任请求体里的座位号。

## 3. 开始检测报告

### 请求

```http
POST /v1/health-reports/start
```

请求体：

```json
{
  "language": "zh"
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `language` | string | 否 | 报告文案语言。当前建议传 `zh`。不传时使用座位上下文或默认中文。 |

### 成功响应

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

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 接口调用状态，成功固定为 `ok`。 |
| `report_id` | string | 本次检测报告 ID。Pad 后续用它轮询报告。 |
| `report_status` | string | 报告状态。开始后为 `collecting`。 |
| `collect_duration_seconds` | number | 采集窗口时长，当前固定为 30 秒。 |
| `started_at` | number | 开始采集时间，Unix 毫秒时间戳。 |
| `estimated_completed_at` | number | 预计采集完成时间，Unix 毫秒时间戳。 |

### 重复点击响应

同一个座位同一时间只允许一个正在采集或生成中的报告。如果 Pad 重复点击开始，服务端返回当前已有报告：

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "collecting",
  "collect_duration_seconds": 30,
  "started_at": 1783420000000,
  "estimated_completed_at": 1783420030000,
  "deduplicated": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deduplicated` | boolean | 为 `true` 表示没有创建新报告，而是返回了当前座位已有的采集任务。 |

## 4. 获取检测报告

### 请求

```http
GET /v1/health-reports/{report_id}
```

路径参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `report_id` | string | 是 | 开始接口返回的报告 ID。 |

### 采集中响应

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

Pad 建议在 `collecting` 或 `generating` 状态下每 1-2 秒轮询一次。

### 生成中响应

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

### 完成响应

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
      "value": 120,
      "unit": "bpm",
      "level": "high",
      "range": {
        "min": 20,
        "max": 180,
        "normal_min": 60,
        "normal_max": 100
      }
    },
    "respiratory_rate": {
      "value": 22,
      "unit": "breaths_per_min",
      "level": "high",
      "range": {
        "min": 6,
        "max": 30,
        "normal_min": 16,
        "normal_max": 20
      }
    },
    "spo2": {
      "value": 94,
      "unit": "percent",
      "level": "low",
      "range": {
        "min": 80,
        "max": 110,
        "normal_min": 95,
        "normal_max": 100
      }
    },
    "body_temperature": {
      "value": 37.8,
      "unit": "celsius",
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
    "score": 55,
    "score_level": "poor",
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

### 失败响应

接口请求成功但报告生成失败时，HTTP 状态仍可为 200，`report_status` 为 `failed`：

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

## 5. 报告字段说明

### 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 接口调用状态，成功固定为 `ok`。 |
| `report_id` | string | 报告 ID。 |
| `report_status` | enum | 报告状态，见“枚举说明”。 |
| `seat_no` | string | 座位号。服务端根据 token/context 确定。 |
| `flight_id` | string | 航班 ID 或航班号。完成报告时返回。 |
| `flight_date` | string | 航班日期，格式 `yyyy-MM-dd`。完成报告时返回。 |
| `generated_at` | number | 报告生成时间，Unix 毫秒时间戳。 |
| `sample_count` | number | 纳入计算的有效样本数。 |
| `metrics` | object | 四项生理指标，供 Pad 渲染指标卡片。 |
| `summary` | object | 综合评分、等级和文本报告。 |

### `metrics` 字段

`metrics` 固定包含以下 key：

| key | 中文含义 | 单位 |
| --- | --- | --- |
| `heart_rate` | 心率 | `bpm` |
| `respiratory_rate` | 呼吸率 | `breaths_per_min` |
| `spo2` | 血氧饱和度 | `percent` |
| `body_temperature` | 体温 | `celsius` |

每个指标对象字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `value` | number 或 null | 30 秒有效样本平均值。心率/呼吸率/血氧取整数，体温保留 1 位小数。无有效样本时为 `null`。 |
| `unit` | enum | 单位。Pad 可映射为中文展示，如 `bpm` -> `次/分钟`。 |
| `level` | enum | 指标等级，Pad 根据该字段决定颜色、提示文案和图标。 |
| `range.min` | number | 指标可视化最小值。 |
| `range.max` | number | 指标可视化最大值。 |
| `range.normal_min` | number | 正常范围下限。 |
| `range.normal_max` | number | 正常范围上限。 |

Pad 渲染建议：

- 指标标题和中英文展示名由 Pad 根据 key 自己本地化。
- 指标颜色由 `level` 决定。
- 进度条总范围使用 `range.min/max`。
- 进度条正常区间标记使用 `range.normal_min/normal_max`。

### `summary` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `score` | number | 综合健康评分，范围 0-100。 |
| `score_level` | enum | 评分等级，Pad 可决定仪表盘颜色。 |
| `physiology_status` | enum | 生理指标整体状态。 |
| `metric_levels` | object | 四项指标等级摘要，便于 Pad 快速渲染“健康小结”。 |
| `overview` | string | 智能分析报告总览。 |
| `interpretations` | string[] | 分项解读。 |
| `suggestions` | string[] | 专业建议。 |
| `disclaimer` | string | 免责声明。 |

`metric_levels` 示例：

```json
{
  "heart_rate": "high",
  "respiratory_rate": "high",
  "spo2": "low",
  "body_temperature": "high"
}
```

## 6. 枚举说明

### `report_status`

| 值 | 说明 |
| --- | --- |
| `collecting` | 正在采集 30 秒 WS 生理数据。 |
| `generating` | 采集已结束，正在计算并生成报告。 |
| `completed` | 报告已生成，可渲染完整页面。 |
| `failed` | 报告生成失败，查看 `error_code` 和 `error_message`。 |
| `expired` | 报告已过期，预留状态。 |

### `metrics.*.level`

| 值 | 说明 | Pad 展示建议 |
| --- | --- | --- |
| `low` | 偏低。心率/呼吸率可展示为偏慢。 | 异常色 |
| `normal` | 正常。 | 正常色 |
| `high` | 偏高。心率/呼吸率可展示为偏快。 | 异常色 |
| `missing` | 未采集到有效数据。 | 灰色或提示重新检测 |
| `invalid` | 数据超出可信范围。 | 灰色或提示重新检测 |

### `score_level`

| 值 | 分数范围 | 说明 |
| --- | --- | --- |
| `excellent` | 90-100 | 优秀 |
| `good` | 75-89 | 良好 |
| `fair` | 60-74 | 一般 |
| `poor` | 0-59 | 较差 |

### `physiology_status`

| 值 | 说明 |
| --- | --- |
| `normal` | 四项指标均正常。 |
| `abnormal` | 至少一项指标偏低、偏高、缺失或无效。 |
| `unknown` | 样本不足，无法判断。 |

## 7. 指标范围和等级

| 指标 | 偏低 | 正常 | 偏高 | 有效范围 |
| --- | --- | --- | --- | --- |
| 心率 `heart_rate` | `[20, 60)` | `[60, 100]` | `(100, 180]` | `[20, 180]` |
| 呼吸率 `respiratory_rate` | `[6, 16)` | `[16, 20]` | `(20, 30]` | `[6, 30]` |
| 血氧饱和度 `spo2` | `[80, 95)` | `[95, 100]` | `(100, 110]` | `[80, 110]` |
| 体温 `body_temperature` | `[20, 36.1)` | `[36.1, 37.2]` | `(37.2, 45]` | `[20, 45]` |

超出有效范围的数据不会纳入平均值计算。

## 8. 错误码

### HTTP 错误

| HTTP 状态 | code | 说明 |
| --- | --- | --- |
| 401 | `MISSING_AUTHORIZATION` | 缺少 `Authorization`。 |
| 401 | `TOKEN_EXPIRED` | cabin token 已过期。 |
| 403 | `INVALID_AUTHORIZATION` | cabin token 无效。 |
| 403 | `HEALTH_REPORT_FORBIDDEN` | 当前 Pad 无权访问该报告。 |
| 404 | `HEALTH_REPORT_NOT_FOUND` | 报告不存在。 |
| 500 | `HEALTH_REPORT_START_FAILED` | 创建报告失败。 |
| 500 | `HEALTH_REPORT_READ_FAILED` | 读取报告失败。 |

### 报告失败状态

| error_code | 说明 |
| --- | --- |
| `INSUFFICIENT_SAMPLES` | 30 秒内没有采集到足够有效样本。 |
| `REPORT_GENERATION_FAILED` | 报告生成过程异常。 |
| `WS_NOT_CONFIGURED` | 服务端未配置 WS 数据源。 |

## 9. WebSocket 数据匹配规则

Moss 只会采集当前处于 `collecting` 状态的座位数据。

接收样本条件：

- 外层 `type` 为 `telemetry`。
- `content.topic` 为 `health`。
- `content.seatNo` 等于当前报告座位号。
- `content.message` 中至少包含一个有效生理指标。

示例：

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

如果 A 座和 B 座同时检测，Moss 会根据 `seatNo` 分别写入各自的 `report_id`。

## 10. 调用示例

### 开始检测

```bash
curl -X POST "$MOSS/v1/health-reports/start" \
  -H "Authorization: Bearer $CABIN_TOKEN" \
  -H "X-Cabin-Tablet-Token: $TABLET_TOKEN" \
  -H "X-Cabin-Tablet-Id: $TABLET_ID" \
  -H "Content-Type: application/json" \
  -d '{"language":"zh"}'
```

### 查询报告

```bash
curl "$MOSS/v1/health-reports/hr_4f8f7f2c8b1a" \
  -H "Authorization: Bearer $CABIN_TOKEN" \
  -H "X-Cabin-Tablet-Token: $TABLET_TOKEN" \
  -H "X-Cabin-Tablet-Id: $TABLET_ID"
```
