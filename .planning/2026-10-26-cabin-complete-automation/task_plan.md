# 客舱订单与飞行自动化完整实现

## Goal

在现有订单和客舱自动化代码基础上，补齐行李状态告警、起降阶段阅读灯/客舱顶灯控制、自动化桌板 `tray_flipped` 前置保护，并用本地模拟接口完成验证。

## Phases

- [completed] Phase 1: 核对现有接口约定、自动化入口和测试缺口
- [completed] Phase 2: 实现行李状态查询、状态 1/15 规则和告警去重
- [completed] Phase 3: 实现阅读灯/客舱顶灯自动控制与桌板保护
- [completed] Phase 4: 增加专项模拟测试并修复回归
- [completed] Phase 5: 运行订单、Cabin 全量、打包和 diff 检查，整理最终状态

## Scope decisions

- 复用现有 `controlBaseUrl`、`controlAuth`、`broadcastApiBaseUrl`、`broadcastApiKey` 和 `broadcastAuth`。
- 行李状态复用 `GET /admin-api/tcp/hardware/status?target=<seatNo>&key=bag`。
- 行李告警复用 `POST /admin-api/cabin/broadcast/error-seat`。
- 状态查询失败不推断行李存在或未锁定，也不执行风险控制。
- 起降阶段只在状态未达到目标时调用控制接口；控制前读取 `reading_light`、`ceiling_state`，桌板同时检查 `tray_state` 和 `tray_flipped`。
- 控制接口返回成功后立即复查目标状态；复查失败记录 `HARDWARE_STATE_NOT_REACHED`，并使用航班/座位/阶段/告警类型去重。
