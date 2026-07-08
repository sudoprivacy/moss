# 生理检测报告接口文档（对外版）

更新时间：2026-07-08

本文档面向 Pad 客户端接入方，说明用户点击开始生理检测后，客户端如何通知服务端开始生成检测报告，以及如何查询报告结果。

## 1. 接口概览

| 能力 | 方法 | 路径 |
| --- | --- | --- |
| 开始生理检测报告 | `POST` | `/v1/health-reports/start` |
| 查询生理检测报告 | `GET` | `/v1/health-reports/{report_id}` |

推荐流程：

```text
1. 用户在 Pad 点击开始生理检测
2. Pad 调用开始接口
3. 服务端立即返回 report_id，状态为 collecting
4. Pad 使用 report_id 每 1-2 秒轮询查询接口
5. report_status 为 completed 后，Pad 根据返回数据渲染报告页面
```

## 2. 鉴权

两个接口均需要携带 cabin token 和 Pad 设备标识。

请求头：

```http
Authorization: Bearer <cabin access token>
X-Cabin-Tablet-Token: <tablet token>
X-Cabin-Tablet-Id: <tablet id>
Content-Type: application/json
```

说明：

- 座位号由服务端根据 token 和 Pad 绑定关系确定。
- 请求体中不需要传 `seatNo`。
- 查询报告时，只允许查询当前座位所属的报告。

## 3. 开始生理检测报告

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
| `language` | string | 否 | 报告文案语言。当前建议传 `zh`。 |

### 成功响应

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "collecting",
  "seat_no": "B",
  "sample_count": 0,
  "progress": {
    "duration_seconds": 30,
    "elapsed_seconds": 0,
    "sample_count": 0
  },
  "started_at": 1783420000000,
  "estimated_completed_at": 1783420030000
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 接口状态，成功固定为 `ok`。 |
| `report_id` | string | 本次检测报告 ID。 |
| `report_status` | enum | 报告状态，开始后为 `collecting`。 |
| `seat_no` | string | 当前报告对应座位号。 |
| `sample_count` | number | 当前有效样本数。 |
| `progress.duration_seconds` | number | 本次采集总时长，单位秒。 |
| `progress.elapsed_seconds` | number | 当前已采集时长，单位秒。 |
| `progress.sample_count` | number | 当前有效样本数。 |
| `started_at` | number | 开始时间，Unix 毫秒时间戳。 |
| `estimated_completed_at` | number | 预计完成时间，Unix 毫秒时间戳。 |

### 重复开始规则

每次调用开始接口都会创建一个新的 `report_id`。

如果同一个座位已有未完成的检测报告，新请求会自动取消旧报告，并以最新返回的 `report_id` 为准。

客户端建议：

- 用户重新点击开始检测时，直接调用开始接口。
- 客户端只轮询最新一次返回的 `report_id`。
- 旧 `report_id` 如果继续查询，可能返回 `cancelled` 状态。

## 4. 查询生理检测报告

### 请求

```http
GET /v1/health-reports/{report_id}
```

路径参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `report_id` | string | 是 | 开始接口返回的报告 ID。 |

## 5. 报告状态响应

### 5.1 采集中：`collecting`

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "collecting",
  "seat_no": "B",
  "sample_count": 8,
  "progress": {
    "duration_seconds": 30,
    "elapsed_seconds": 12,
    "sample_count": 8
  },
  "started_at": 1783420000000,
  "estimated_completed_at": 1783420030000
}
```

客户端处理：

- 继续轮询查询接口。
- 建议轮询间隔为 1-2 秒。

### 5.2 生成中：`generating`

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "generating",
  "seat_no": "B",
  "sample_count": 26,
  "progress": {
    "duration_seconds": 30,
    "elapsed_seconds": 30,
    "sample_count": 26
  },
  "started_at": 1783420000000,
  "estimated_completed_at": 1783420030000
}
```

客户端处理：

- 继续轮询查询接口。
- 可展示“报告生成中”。

### 5.3 已完成：`completed`

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
    "score": 76.5,
    "score_level": "pass",
    "emotion_status": "pass",
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

客户端处理：

- 停止轮询。
- 根据 `metrics` 渲染四项指标卡片。
- 根据 `summary` 渲染综合评分、情绪状态、生理指标状态、健康小结、分项解读和建议。

### 5.4 失败：`failed`

```json
{
  "status": "ok",
  "report_id": "hr_4f8f7f2c8b1a",
  "report_status": "failed",
  "seat_no": "B",
  "sample_count": 0,
  "error_code": "INSUFFICIENT_SAMPLES",
  "error_message": "未采集到足够的有效生理检测数据，请重新检测。"
}
```

客户端处理：

- 停止轮询。
- 展示失败原因。
- 可引导用户重新检测。

### 5.5 已取消：`cancelled`

```json
{
  "status": "ok",
  "report_id": "hr_old",
  "report_status": "cancelled",
  "seat_no": "B",
  "sample_count": 8,
  "error_code": "SUPERSEDED_BY_NEW_REPORT",
  "error_message": "已开始新的检测，本次检测已取消。"
}
```

客户端处理：

- 停止轮询该旧报告。
- 以最新一次开始接口返回的 `report_id` 为准。

## 6. 字段说明

### 6.1 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 接口状态，成功固定为 `ok`。 |
| `report_id` | string | 报告 ID。 |
| `report_status` | enum | 报告状态。 |
| `seat_no` | string | 座位号。 |
| `flight_id` | string | 航班 ID 或航班号。 |
| `flight_date` | string | 航班日期，格式 `yyyy-MM-dd`。 |
| `generated_at` | number | 报告生成时间，Unix 毫秒时间戳。 |
| `sample_count` | number | 有效样本数。 |
| `progress` | object | 采集进度，采集中和生成中返回。 |
| `metrics` | object | 四项生理指标，完成后返回。 |
| `summary` | object | 综合分析结果，完成后返回。 |
| `error_code` | string | 失败或取消原因编码。 |
| `error_message` | string | 失败或取消原因文案。 |

### 6.2 `metrics`

`metrics` 固定包含以下四个 key：

| key | 中文含义 | 单位 | Pad 展示建议 |
| --- | --- | --- | --- |
| `heart_rate` | 心率 | `bpm` | 次/分钟 |
| `respiratory_rate` | 呼吸率 | `breaths_per_min` | 次/分钟 |
| `spo2` | 血氧饱和度 | `percent` | `%` |
| `body_temperature` | 体温 | `celsius` | `°C` |

每个指标对象字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `value` | number 或 null | 指标值。无有效数据时为 `null`。 |
| `unit` | string | 单位。 |
| `level` | enum | 指标等级。 |
| `range.min` | number | 可视化最小值。 |
| `range.max` | number | 可视化最大值。 |
| `range.normal_min` | number | 正常范围下限。 |
| `range.normal_max` | number | 正常范围上限。 |

### 6.3 `summary`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `score` | number | 综合评分，范围 0-100。 |
| `score_level` | enum | 评分等级。 |
| `emotion_status` | enum | 情绪状态。 |
| `physiology_status` | enum | 生理指标整体状态。 |
| `metric_levels` | object | 四项指标等级摘要。 |
| `overview` | string | 分析总览。 |
| `interpretations` | string[] | 分项解读。 |
| `suggestions` | string[] | 建议。 |
| `disclaimer` | string | 免责声明。 |

## 7. 枚举说明

### 7.1 `report_status`

| 值 | 说明 |
| --- | --- |
| `collecting` | 正在采集。 |
| `generating` | 正在生成报告。 |
| `completed` | 报告已完成。 |
| `failed` | 报告生成失败。 |
| `cancelled` | 报告已被新检测取消。 |
| `expired` | 报告已过期，预留状态。 |

### 7.2 `metrics.*.level`

| 值 | 说明 |
| --- | --- |
| `low` | 偏低。 |
| `normal` | 正常。 |
| `high` | 偏高。 |
| `missing` | 未采集到有效数据。 |
| `invalid` | 数据无效。 |

### 7.3 `score_level`

| 值 | 分数范围 | 说明 |
| --- | --- | --- |
| `good` | 80-100 | 良好 |
| `pass` | 60-79 | 合格 |
| `fail` | 0-59 | 不合格 |

### 7.4 `emotion_status`

| 值 | 说明 |
| --- | --- |
| `good` | 良好 |
| `pass` | 合格 |
| `fail` | 不合格 |
| `unknown` | 暂无法判断 |

### 7.5 `physiology_status`

| 值 | 说明 |
| --- | --- |
| `normal` | 四项指标均正常。 |
| `abnormal` | 至少一项指标异常或缺失。 |
| `unknown` | 暂无法判断。 |

## 8. 指标范围

| 指标 | 偏低 | 正常 | 偏高 | 有效范围 |
| --- | --- | --- | --- | --- |
| 心率 `heart_rate` | `[20, 60)` | `[60, 100]` | `(100, 180]` | `[20, 180]` |
| 呼吸率 `respiratory_rate` | `[6, 16)` | `[16, 20]` | `(20, 30]` | `[6, 30]` |
| 血氧饱和度 `spo2` | `[80, 95)` | `[95, 100]` | `(100, 110]` | `[80, 110]` |
| 体温 `body_temperature` | `[20, 36.1)` | `[36.1, 37.2]` | `(37.2, 45]` | `[20, 45]` |

客户端可根据 `level` 决定颜色和状态文案，也可结合 `range` 绘制进度条或区间标尺。

## 9. HTTP 错误响应

HTTP 失败时响应格式：

```json
{
  "status": "error",
  "code": "HEALTH_REPORT_NOT_FOUND",
  "message": "Health report was not found"
}
```

常见错误：

| HTTP 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `MISSING_SEAT_CONTEXT` | 当前请求无法识别座位信息。 |
| 401 | `MISSING_AUTHORIZATION` | 缺少 `Authorization`。 |
| 401 | `TOKEN_EXPIRED` | token 已过期。 |
| 403 | `INVALID_AUTHORIZATION` | token 无效。 |
| 403 | `HEALTH_REPORT_FORBIDDEN` | 无权访问该报告。 |
| 404 | `HEALTH_REPORT_DISABLED` | 生理检测报告接口未启用。 |
| 404 | `HEALTH_REPORT_NOT_FOUND` | 报告不存在。 |
| 500 | `INTERNAL_ERROR` | 服务端异常。 |

## 10. 调用示例

### 开始检测报告

```bash
curl -X POST "$BASE_URL/v1/health-reports/start" \
  -H "Authorization: Bearer $CABIN_TOKEN" \
  -H "X-Cabin-Tablet-Token: $TABLET_TOKEN" \
  -H "X-Cabin-Tablet-Id: $TABLET_ID" \
  -H "Content-Type: application/json" \
  -d '{"language":"zh"}'
```

### 查询检测报告

```bash
curl "$BASE_URL/v1/health-reports/hr_4f8f7f2c8b1a" \
  -H "Authorization: Bearer $CABIN_TOKEN" \
  -H "X-Cabin-Tablet-Token: $TABLET_TOKEN" \
  -H "X-Cabin-Tablet-Id: $TABLET_ID"
```

## 11. 客户端接入建议

1. 用户点击开始检测后，立即调用开始接口并保存最新 `report_id`。
2. 查询接口轮询间隔建议为 1-2 秒。
3. `collecting` 和 `generating` 状态下继续轮询。
4. `completed`、`failed`、`cancelled` 状态下停止轮询。
5. 用户重新开始检测时，以最新 `report_id` 为准，旧报告不再展示。
6. 报告页面渲染应以接口返回字段为准，不要在客户端自行重新计算等级。
7. 本报告仅用于客舱健康状态辅助提示，不作为医疗诊断依据。
