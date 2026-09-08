# moss LB HA 部署与集成测试 SOP

本文件是 moss LB（Phase A active/passive + Phase B sticky active-active）的部署说明
与集成测试 SOP，对应源设计文档《moss Phase 2 HA/LB 设计与开发方案》第 19.1–19.3 节。

交付物：
- `deploy/nginx/moss-active-passive.conf` — Phase A（Nginx active/passive）
- `deploy/nginx/moss-sticky-active-active.conf` — Phase B（Nginx sticky active-active）
- `deploy/docker-compose.ha.yml` — Docker Compose HA 示例（方案 A + nexus external）
- `deploy/k8s/moss-ingress.yaml` — K8s Ingress 示例
- 本文件（测试 SOP + 运维说明）

> 前置实测（计划 §六 T1–T5）必须在 **Linux 原生文件系统**上执行并通过后，方案 A
> 共享 SQLite 与 nexus external 拓扑方可定案。不得用 Windows 路径 bind mount
> （Docker Desktop 文件共享层的文件锁/mmap 语义与 Linux 原生不等价，结果不可外推）。

---

## 1. 启动 HA 环境

```bash
cd deploy
# LB 对外入口地址（ws_url 指向它）。示例：http://<宿主IP>:80
export MOSS_PUBLIC_BASE_URL=http://<LB 入口>
# 默认加载 Phase A（active/passive）conf。
docker-compose -f docker-compose.ha.yml -p moss-ha up -d
```

切换到 **Phase B（sticky active-active）**：把 `docker-compose.ha.yml` 中 nginx 的
挂载从 `moss-active-passive.conf` 改为 `moss-sticky-active-active.conf`，`a`/`b` 已配
`MOSS_INSTANCE_ID=a|b`，然后重建 nginx：

```bash
docker-compose -f docker-compose.ha.yml -p moss-ha up -d --force-recreate nginx
```

停机（注意 `stop_grace_period: 45s`，drain 全过程见下）：

```bash
docker-compose -f docker-compose.ha.yml -p moss-ha down
```

---

## 2. 集成测试（对应文档 19.1–19.3）

假设 LB 入口为 `http://localhost`（按实际调整）。

### 19.1 Nginx proxy 测试

| 项 | 命令 / 操作 | 预期 |
|---|---|---|
| 普通 HTTP API | `curl -i http://localhost/healthz` | 200，经 nginx 到达后端 |
| WebSocket upgrade | 用客户端连 `ws://localhost/ws/sessions/<sessionId>` | upgrade 成功（101）；非 owner live 实例返回 409（现状行为） |
| SSE build-events 实时 | `curl -N http://localhost/api/v1/wikis/<wikiId>/build-events` | 事件实时到达、不被缓冲（`X-Accel-Buffering: no` 生效） |
| SSE mcp-events 实时 | `curl -N http://localhost/api/v1/mcp/events` | 同上 |
| cabin SSE（**条件项**） | cabin 默认关闭（`server.json` `cabin.enabled:false`），需 `CABIN_ENABLED=1` + cabin token 才可测；启用后 `curl -N -X POST http://localhost/v1/ai-chat/send ...` | 流式实时、不缓冲 |
| >100MB 上传不被 413 | **必须用无应用层限额的 raw body 接口**，如 `POST /api/v1/upload/logo`；**不得**用 documents 上传接口（其自身有 50MB 应用层限额，会得到应用层 413 造成误判） | 不出现 nginx 413（`client_max_body_size 1024m` 生效） |

### 19.2 active/passive 测试

| 项 | 命令 / 操作 | 预期 |
|---|---|---|
| 主实例正常时流量落 a | 反复 `curl -s http://localhost/readyz`，看响应 `instance_id` | 恒为 `a` |
| `docker kill`（=T3 切流/收养/重连） | `docker kill moss-server-a` | Nginx 按 `fail_timeout` 切流到 b → 心跳 30s 过期 → b 收养 a 的 session → WS 客户端重连成功 |
| `docker stop`（SIGTERM 滚动下线，任务 7 核心） | `docker stop moss-server-a`，同时观测（下文“drain 两拍时序”） | 见下方链路 |
| 重启回归 | `docker start moss-server-a`（或 `docker restart`） | 固定 id upsert 生效、不崩溃循环；a 回归后 `/readyz` 正常、流量回落 a |

**`docker stop` 的 drain 两拍时序（按代码实证）**：
1. SIGTERM → `/readyz` 立即返回 503；
2. （有轮询方时）LB 摘流 a；
3. 存量 WS/SSE 在 grace 窗口（30s）内**持续正常收发**（drain 不主动断连）；
4. grace 超时进入清理链——`server.close()` 在存量连接上挂起，**不主动断连**；
5. grace+10s（=40s）serverCli 兜底 `exit(1)` 随进程终止断开全部连接
   （若客户端在 grace 窗口内主动断开，则清理链完整走完、进程优雅退出）；
6. 新请求落 b 且 b 的 `/readyz` 正常；重启 a 后回归。

> `stop_grace_period: 45s > 40s` 保证 exit(1) 先于 docker SIGKILL。

### 19.3 sticky active-active 测试（Phase B conf）

| 项 | 命令 / 操作 | 预期 |
|---|---|---|
| 无 cookie → pool | `curl -s http://localhost/readyz`（不带 cookie） | 落 pool，`instance_id` 在 a/b 间分摊 |
| `moss_route=a` → a | `curl -s --cookie "moss_route=a" http://localhost/readyz` | `instance_id=a` |
| `moss_route=b` → b | `curl -s --cookie "moss_route=b" http://localhost/readyz` | `instance_id=b` |
| WS/SSE 同 cookie 路由 | 带 `moss_route=a` 的 WS/SSE | 落 a |
| 停 b 后 `moss_route=b` 的行为 | `docker stop moss-server-b`，再带 `moss_route=b` 请求 | 502（map 直指单实例，无自动 fallback）——以 T4-④ 实测为准，如实记录 |

### 现状行为回归（任务 5 缩减为验证）
- 非 owner 实例 WS upgrade 收 **409**。
- `ws_url` 遵循 `MOSS_PUBLIC_BASE_URL`（LB 入口）。

---

## 3. /readyz 摘流机制与轮询建议

- 开源 nginx **无主动健康检查**，503 摘流依赖**被动失败计数**（`max_fails=3`
  / `fail_timeout=10s`）。因此 HA 部署需要存在 **`/readyz` 轮询方**（外部监控或运维
  脚本）持续产生请求，drain 摘流才能在 grace 窗口内生效；无轮询方时退化为“进程退出
  后连接失败摘流”（fail_timeout 窗口内）。
- 轮询间隔建议 **≥5s**（docker/k8s 模式每次 `/readyz` 探测会 spawn 子进程 docker
  info / kubectl）。结果缓存/TTL 不做（`max_fails=3` 计数对单次抖动有天然缓冲）。
- **Phase B 专属约束**：`/readyz` 轮询方**不得携带 `moss_route` cookie**——携带会命中
  单 server 组（moss_a/moss_b），503 被透传不计数，摘流失效。
- **摘除断续振荡**：`max_fails` 摘除仅在 `fail_timeout=10s` 窗口内有效，窗口过后
  nginx 恢复试探——30s drain 全窗口呈“摘 10s / 试探恢复”循环，期间偶发请求（尤其
  默认不重试的 POST）会真实收到 draining 实例的 503。
- **监控语义限制**：经 LB 轮询 `/readyz` 时，draining 实例的 503 被 nginx 内部
  next_upstream 重试消化，轮询方永远拿到另一实例的 200（摘流计数仍生效，但 LB 层
  `/readyz` 告警看不到 draining 信号）。实例级告警须**不经 LB 直达实例**。

### 实例级 /readyz 直访（a/b 不暴露宿主端口）

```bash
# 方式一：docker exec + node 内置 fetch（node 22，镜像必有 node；不假设含 curl）
docker exec moss-server-a node -e "fetch('http://127.0.0.1:43127/readyz').then(r=>r.text()).then(console.log)"

# 方式二：让监控容器接入 moss-network，直访容器名 moss-server-a:43127 / moss-server-b:43127
```

---

## 4. 已知限制（计划 §八）

1. **桌面客户端 / admin web 无 WS 409 自动重连**（源码在 sudocode 仓库 / 现状行为）：
   Phase A 配 LB 地址即可用；Phase B 无 cookie 可能 409 循环；failover 后 session
   恢复依赖 `ws_url` 指向 LB 入口。
2. **Phase B 滚动重启窗口**：实例退出到重新就绪期间，携带该实例 `moss_route` cookie
   的请求得 502（无自动 fallback），且 502 不清除浏览器 cookie，用户持续 502 直至该
   实例恢复（drain 窗口内业务请求正常，502 仅在进程退出后出现；以 T4-④ 实测定稿）。
3. **Phase B 双活运行在共享 SQLite 上**为受限部署形态（源文档 14.2：SQLite 不建议作为
   生产 active-active DB）；并发写能力以 T1 压力实测为准；生产级依赖已剔除的 Phase C。
4. **503 摘流为被动计数**：无 `/readyz` 轮询方时 drain 摘流退化为进程退出后连接失败
   摘流；且存在“摘 10s / 试探恢复”振荡（见第 3 节）。
5. **nexus 共享故障域**：external 模式下双实例的 readyz nexus 探测指向同一 nexus 容器
   ——nexus 重启/抖动窗口内双实例同时 503 → LB 摘空全部后端 → 整站新请求 502（含不依赖
   nexus 的 API）。nexus 容器 `restart: always` + 启动快，窗口秒级（T2 观测实际恢复
   时长）。
6. **主备同主机为共同故障域**（源文档 22 节定位：入口层 HA，非完整 HA）。
7. **host runtime 跨实例接管能力有限**（源文档 20 节；T5 记录实际边界）。
8. **K8s 仅 Ingress 示例**；SQLite 多 pod 部署不在范围。
9. **failover 后存量 runner 的 auth proxy 指向已死实例**：runner env 在 spawn 时固化
   `SUDOWORK_AUTH_PROXY_URL` 为原实例地址，user 容器独立存活——切流后 b 收养 a 的
   session，但存量容器的凭证注入外呼仍指向 `moss-server-a:12013`，a 不可达窗口内失效、
   a 回归后自愈；session 的 WS/ACP 主链路不经 auth proxy。完整修复属已剔除的
   owner-aware 范围（T5-③ 记录）。
