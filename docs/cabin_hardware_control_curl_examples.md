# 客舱硬件控制接口 curl 示例

本文档用于现场手动验证客户硬件控制接口是否正常。

基础地址：

```text
http://1.94.107.87:48081
```

鉴权 Header：

```text
Authorization: test1
```

说明：

- `seatNo=A` 按客户现场实际座位/通道编码替换，例如 `A`、`B` 等。
- 不要把 `A` 自行改成 `01A`，除非客户现场接口明确要求 `01A`。
- 正常情况一般应返回 `200`，并包含类似“指令下发成功”或 `accepted` 的结果。
- 如果返回 `502` 或超时，通常是客户控制网关或设备链路不可用。

## 1. 打开小桌板

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/tray/open?seatNo=A' \
  --header 'Authorization: test1'
```

## 2. 关闭小桌板

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/tray/close?seatNo=A' \
  --header 'Authorization: test1'
```

## 3. 调整座椅靠背/坐垫位置

`position` 范围：`0-100`。

调整到 `30`：

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/cushion?seatNo=A&position=30' \
  --header 'Authorization: test1'
```

归位到 `0`：

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/cushion?seatNo=A&position=0' \
  --header 'Authorization: test1'
```

## 4. 座椅通风

`level` 范围：`0-10`。

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/ventilation?seatNo=A&level=3' \
  --header 'Authorization: test1'
```

## 5. 座椅加热

`level` 范围：`0-10`。

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/heating?seatNo=A&level=3' \
  --header 'Authorization: test1'
```

## 6. 座椅按摩

`level` 范围：`0-10`。

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/massage?seatNo=A&level=3' \
  --header 'Authorization: test1'
```

## 7. 打开阅读灯

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/light?seatNo=A&on=true&pwm=80' \
  --header 'Authorization: test1'
```

## 8. 关闭阅读灯

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/light?seatNo=A&on=false' \
  --header 'Authorization: test1'
```

## 9. 调整阅读灯亮度

`pwm` 范围：`0-100`。

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/light/brightness?seatNo=A&pwm=50' \
  --header 'Authorization: test1'
```

## 10. 启动生理检测采集

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/health/start?seatNo=A' \
  --header 'Authorization: test1'
```

## 11. 停止生理检测采集

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/seat/health/stop?seatNo=A' \
  --header 'Authorization: test1'
```

## 12. 设置客舱顶灯颜色/亮度

`r/g/b` 范围：`0-255`，`brightness` 范围：`0-100`。

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/cabin/ceiling/color?seatNo=A&r=20&g=20&b=20&brightness=40' \
  --header 'Authorization: test1'
```

## 13. 打开客舱顶灯

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=A&on=true' \
  --header 'Authorization: test1'
```

## 14. 关闭客舱顶灯

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/cabin/ceiling/light?seatNo=A&on=false' \
  --header 'Authorization: test1'
```

## 15. 切换客舱场景

`preset` 示例：`boarding`、`reading`、`rest`。

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/cabin/scene?seatNo=A&preset=reading' \
  --header 'Authorization: test1'
```

## 16. 清除客舱场景

```bash
curl --location --request POST 'http://1.94.107.87:48081/admin-api/tcp-client/cmd/cabin/scene/clear?seatNo=A' \
  --header 'Authorization: test1'
```
