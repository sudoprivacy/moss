# Moss 容器访问乘客信息接口失败现场排查方案

文档版本：1.0  
更新日期：2026-10-19  
适用环境：Mac Studio、Docker Desktop、`moss-server` 容器

## 1. 适用场景

出现以下日志时使用本方案：

```text
error_code: SEAT_CONTEXT_FAILED
error_message: Seat context request failed: fetch failed
upstream: seat-context
```

典型现象：

- Mac 宿主机可以访问 `192.168.20.2:48081`。
- `moss-server` 容器内访问同一地址失败。
- 重启容器后可能恢复。

本方案用于判断故障发生在以下哪一层：

1. 对方乘客信息服务或现场网络。
2. Mac 宿主机网络、VPN或安全策略。
3. Docker Desktop 网络出口。
4. `moss-network` 自定义网络。
5. 单个 `moss-server` 容器网络状态。
6. 接口路径、鉴权、请求参数或响应数据。

## 2. 排查原则

发现问题后，先不要重启容器或 Docker Desktop。重启会清除故障现场，导致无法确认根因。

先完成第3至第7节的信息采集，再根据第8节的判断表处理。业务需要紧急恢复时，在采集完信息后执行：

```bash
docker restart moss-server
```

## 3. 记录故障时间和运行状态

在 Mac 宿主机终端执行：

```bash
date

docker inspect moss-server \
  --format 'status={{.State.Status}} started={{.State.StartedAt}} restart={{.RestartCount}} image={{.Config.Image}}'

docker version
```

记录以下信息：

- 故障发生时间。
- 容器启动时间。
- 容器重启次数。
- 当前镜像名称和版本。
- Docker Client 和 Server 版本。

如果故障发生在服务器开机后，容器启动时间明显早于物理网络就绪时间，可能存在开机启动顺序问题。

## 4. 同时测试宿主机和容器

目标地址：

```text
192.168.20.2:48081
```

### 4.1 宿主机测试

```bash
curl -sv \
  --connect-timeout 5 \
  --max-time 10 \
  -o /dev/null \
  'http://192.168.20.2:48081/'
```

### 4.2 容器测试

```bash
docker exec moss-server curl -sv \
  --connect-timeout 5 \
  --max-time 10 \
  -o /dev/null \
  'http://192.168.20.2:48081/'
```

这里检测的是 TCP 和 HTTP 连通性。收到任何 HTTP 状态码，包括 `404`，都代表网络已经连通。

结果说明：

- `Connected to 192.168.20.2`：TCP连接成功。
- `Connection refused`：连接被主动拒绝。
- `Connection timed out`：连接超时，通常是路由或防火墙丢包。
- `No route to host`：没有可用路由。

## 5. 获取容器底层错误码

Moss 日志中的 `fetch failed` 信息不足。使用镜像内已有的 Node.js 直接测试 TCP，可以获得具体错误码：

```bash
docker exec moss-server node -e '
const net = require("node:net");
const socket = net.createConnection({
  host: "192.168.20.2",
  port: 48081
});

socket.setTimeout(5000);

socket.on("connect", () => {
  console.log({
    result: "connected",
    localAddress: socket.localAddress,
    localPort: socket.localPort,
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort
  });
  socket.end();
});

socket.on("timeout", () => {
  console.error({ result: "failed", code: "ETIMEDOUT" });
  socket.destroy();
  process.exitCode = 1;
});

socket.on("error", error => {
  console.error({
    result: "failed",
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    address: error.address,
    port: error.port
  });
  process.exitCode = 1;
});
'
```

错误码含义：

| 错误码 | 含义 | 重点检查 |
| --- | --- | --- |
| `ECONNREFUSED` | TCP连接被主动拒绝 | 对方服务监听、远端防火墙、Docker出口状态 |
| `ETIMEDOUT` | TCP连接超时 | 路由、防火墙、VPN、安全软件 |
| `ENETUNREACH` | 网络不可达 | Docker路由、宿主机网卡和VPN路由 |
| `EHOSTUNREACH` | 主机不可达 | 网关、目标主机或二层网络 |
| `ECONNRESET` | 连接建立后被重置 | 中间设备、服务端连接策略 |

## 6. 检查容器代理和网络信息

当前镜像未安装 `ping`、`ip`、`ss`、`nc` 和 `dig`。出现 `ping: executable file not found` 只表示镜像没有安装 ping，不代表网络异常。

使用以下现有命令采集信息：

```bash
docker exec moss-server sh -c '
echo "=== proxy ==="
env | grep -Ei "^(http|https|all|no)_proxy=" || true
echo "=== route ==="
cat /proc/net/route
echo "=== resolv ==="
cat /etc/resolv.conf
'

docker network inspect moss-network
```

同时在 Mac 宿主机执行：

```bash
route -n get 192.168.20.2
env | grep -i proxy
```

检查宿主机是否通过特殊网卡、VPN或代理访问目标地址，而 Docker容器使用了不同出口。

## 7. 使用相同镜像创建临时容器对比

该步骤用于区分单个容器、`moss-network` 和 Docker Desktop整体网络问题。

获取当前镜像名称：

```bash
IMAGE=$(docker inspect --format '{{.Config.Image}}' moss-server)
echo "$IMAGE"
```

### 7.1 使用 `moss-network` 测试

```bash
docker run --rm \
  --network moss-network \
  --entrypoint node \
  "$IMAGE" \
  -e 'const s=require("node:net").connect(48081,"192.168.20.2",()=>{console.log("connected");s.end()});s.on("error",e=>{console.error(e.code,e.message);process.exit(1)});s.setTimeout(5000,()=>{console.error("ETIMEDOUT");s.destroy();process.exit(1)})'
```

### 7.2 使用 Docker默认网络测试

```bash
docker run --rm \
  --entrypoint node \
  "$IMAGE" \
  -e 'const s=require("node:net").connect(48081,"192.168.20.2",()=>{console.log("connected");s.end()});s.on("error",e=>{console.error(e.code,e.message);process.exit(1)});s.setTimeout(5000,()=>{console.error("ETIMEDOUT");s.destroy();process.exit(1)})'
```

## 8. 结果判断与处理

| 宿主机 | 现有容器 | 临时 `moss-network` 容器 | 默认网络容器 | 故障判断 | 处理建议 |
| --- | --- | --- | --- | --- | --- |
| 失败 | 失败 | 失败 | 失败 | 对方服务或现场网络异常 | 检查对方服务、端口、路由和防火墙 |
| 成功 | 失败 | 成功 | 成功 | 单个 `moss-server` 容器网络状态异常 | 重启或重新创建 `moss-server` |
| 成功 | 失败 | 失败 | 成功 | `moss-network` 异常 | 重新创建 Compose网络和容器 |
| 成功 | 失败 | 失败 | 失败 | Docker Desktop、VPN或Mac安全策略异常 | 重启 Docker Desktop，检查VPN和安全软件 |
| 成功 | 成功 | 成功 | 成功 | 网络正常 | 继续检查接口鉴权、参数和响应内容 |

### 8.1 单个容器异常

先恢复业务：

```bash
docker restart moss-server
```

如果多次复现，需要调整开机自启顺序，并保留下一次故障发生时的完整诊断输出。

### 8.2 `moss-network` 异常

在部署目录执行：

```bash
docker compose -p moss-server down
docker compose -p moss-server up -d
```

该操作会重新创建 Compose容器和网络，应在完成第3至第7节的信息采集后执行。

### 8.3 Docker Desktop整体网络异常

依次检查：

1. Mac物理网卡是否已连接。
2. VPN是否已连接并下发目标网段路由。
3. Mac安全软件是否拦截 Docker Desktop 出站连接。
4. Docker Desktop是否刚完成冷启动或升级。

保留诊断信息后重启 Docker Desktop，再重新测试。

## 9. TCP正常后的完整接口验证

TCP连通后，在容器中验证乘客信息接口：

```bash
docker exec moss-server curl -sv \
  --connect-timeout 5 \
  --max-time 15 \
  --request POST \
  'http://192.168.20.2:48081/admin-api/cabin/tablet-login/get-seat-context' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: 替换为现场passengerInfoAuth' \
  --data-raw '{"aircraftNo":"B-WITHFLIGHT-01","seatNo":"4B"}'
```

结果说明：

| 结果 | 含义 |
| --- | --- |
| HTTP 200且`code=0` | 接口正常 |
| HTTP 401 | Authorization不正确 |
| HTTP 404 | 接口路径不正确 |
| HTTP 2xx但业务`code`非0 | 对方接口业务校验失败，查看`msg` |
| `code=0`但Moss返回`SEAT_CONTEXT_INVALID` | 缺少 flightId、flightDate或passengerRef |

## 10. 恢复后验证

完成恢复操作后执行：

```bash
docker exec moss-server curl -sv \
  --connect-timeout 5 \
  --max-time 10 \
  -o /dev/null \
  'http://192.168.20.2:48081/'
```

随后让 UE重新调用 `/v1/voice/query`，检查日志中同一个 `request_id` 对应的记录：

- `upstream: seat-context` 应为 `ok: true`。
- `/v1/voice/query` 不应再返回 `SEAT_CONTEXT_FAILED`。
- 如果仍失败，继续按照新错误码排查后续 ASR、AI或响应字段问题。

## 11. 提交给技术支持的信息

现场反馈问题时，请提供：

1. 故障发生时间和时区。
2. 宿主机curl完整输出。
3. 容器curl完整输出。
4. Node TCP测试输出，包括 `code`、`address` 和 `port`。
5. `docker inspect moss-server` 的状态、启动时间、重启次数和镜像版本。
6. `docker network inspect moss-network` 输出。
7. 宿主机 `route -n get 192.168.20.2` 输出。
8. 临时容器在 `moss-network` 和默认网络下的测试结果。
9. 重启容器前后的测试结果。
10. 对方服务在相同时间是否正常、是否发生重启或配置变更。

## 12. 开机自启场景说明

当前 Compose使用 `restart: always`。Docker Desktop启动后会立即启动 `moss-server`，但不会等待Mac物理网卡、VPN路由或对方服务就绪。

正常情况下，网络恢复后新连接也应恢复。如果宿主机已经恢复而容器仍无法访问，直到重启容器才恢复，则说明容器或 Docker Desktop网络状态没有正确刷新。

开机自启验收时建议记录：

- Mac开机时间。
- Docker Desktop可用时间。
- `moss-server`启动时间。
- 宿主机首次访问目标接口成功时间。
- 容器首次访问目标接口成功时间。

这些时间能够判断是否存在容器早于网络就绪启动的竞态。
