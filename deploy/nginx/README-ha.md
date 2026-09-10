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

### owner-aware 路由测试（Phase C 路由层交付）

前置：Phase B conf（两级 map：`$arg_moss_route` 优先 / `$cookie_moss_route` 兜底），
a/b 均配置 `MOSS_INSTANCE_ID`。

| 用例 | 步骤 | 预期 |
|---|---|---|
| owner 元数据下发 | 经 LB 登录建 session，`GET /api/v1/sessions/:id` | 响应含 `owner_instance_id=<创建实例>`、`owner_live=true`，`ws_url` 含 `?moss_route=<owner>` |
| create 直连路由 | `POST /api/v1/sessions` 后立即按 `ws_url` 建 WS | 直达创建实例，无 409（create 时 attempt 已同步拉起） |
| map 优先级 | 带 `Cookie: moss_route=b` 请求 URL 附 `?moss_route=a` | 落实例 a（query 优先）；仅 cookie 时落 b；两者皆无落 pool |
| failover 全链路 | 桌面端开会话发消息 → `docker kill` owner 容器 | WS 断 → 客户端重拉 metadata（接管完成前 owner_live=false、无 route → pool → CAS 接管）→ 恢复，无 409 死循环 |
| 首连自愈 | kill owner 后立即从桌面端发起新消息 | 最多 9 次退避（1/2/4/8/16/30/30/30s）内自动恢复 |
| 单实例回归 | 不设 `MOSS_INSTANCE_ID` 启动 | 响应无 route cookie、`ws_url` 无 query、行为不变 |

**双侧一致性约束（部署必查）**：nginx map 的键/值（`a`→`moss_a` 等）必须与各实例
`MOSS_INSTANCE_ID` 一致，且 query/cookie 参数名 = `MOSS_ROUTE_COOKIE_NAME`（默认
`moss_route`）——任一不一致则静默退化为 pool。HA 集群**所有实例必须配置
`MOSS_INSTANCE_ID`**（漏配实例不下发 route、其 runner 无 fencing，失败模式静默）。

### 企微回调（43128 双入口）

- compose 已给 a/b 设置 `MOSS_CALLBACK_PORT=43128`，nginx 暴露
  `${MOSS_CALLBACK_PUBLIC_PORT:-43128}`；两份 conf 均有独立 `moss_callback`
  upstream（43128 成员，**不得复用主端口 upstream**——主端口无回调路由会 404）。
- 回调服务无状态（每次请求从共享 DB 读配置），双入口轮询安全；seq 已单语句原子
  自增 + `(corp_app_id, seq)` 唯一索引，并发回调不产生重复 seq。
- 企微管理后台回调 URL 填 `http://<LB>:43128/api/v1/corp-apps/callback/<id>`。
- 不启用企微回调的部署：不暴露 43128 端口即可，零影响。

### 跨实例事件/规则刷新（多实例功能正确性）

- `mcp/events` SSE：本实例变更即时广播；其他实例的变更经 3s 指纹轮询兜底送达
  （`mcp.changed` / `mcp.policy.changed` 按指纹分组区分）。
- auth proxy rules：config items 在实例 A 修改后，实例 B 经 5s 常驻指纹轮询自动
  重载（凭证值在 Nexus 实时取，天然跨实例一致，无需轮询）。

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

1. **WS 409 重连能力（owner-aware 路由已交付）**：服务端 create/GET/resume 响应含
   `owner_instance_id`/`owner_live`，且 `ws_url` 多实例下携带 `?moss_route=<owner>`
   （本 conf 两级 map：query 优先、cookie 兜底）；桌面客户端（Electron）已具备首连/
   turn 中途失败的有界重试自愈（9 次尝试、退避累计 121s，覆盖最坏接管窗口）。admin
   web 无 WS 客户端（仅 EventSource SSE），经浏览器 cookie sticky 覆盖。
2. **Phase B 滚动重启窗口**：实例退出到重新就绪期间，携带该实例 `moss_route` cookie
   的请求得 502（无自动 fallback），且 502 不清除浏览器 cookie，用户持续 502 直至该
   实例恢复（drain 窗口内业务请求正常，502 仅在进程退出后出现；以 T4-④ 实测定稿）。
3. **Phase B 双活运行在共享 SQLite 上**为受限部署形态（源文档 14.2：SQLite 不建议作为
   生产 active-active DB）；**PostgreSQL 后端已交付（P1）**：设 `MOSS_DATABASE_URL`
   即切换（同主机 compose 亦可加该 env），跨主机/K8s 形态默认 PG。PG 侧机制（建表/
   CAS/fencing/seq 唯一约束+重试/advisory lock）已在真库测试覆盖（pgBackend.test.ts）。
4. **503 摘流为被动计数**：无 `/readyz` 轮询方时 drain 摘流退化为进程退出后连接失败
   摘流；且存在“摘 10s / 试探恢复”振荡（见第 3 节）。
5. **nexus 共享故障域**：external 模式下双实例的 readyz nexus 探测指向同一 nexus 容器
   ——nexus 重启/抖动窗口内双实例同时 503 → LB 摘空全部后端 → 整站新请求 502（含不依赖
   nexus 的 API）。nexus 容器 `restart: always` + 启动快，窗口秒级（T2 观测实际恢复
   时长）。
6. **主备同主机为共同故障域**（源文档 22 节定位：入口层 HA，非完整 HA）。
7. **host runtime 跨实例接管能力有限**（源文档 20 节；T5 记录实际边界）。
8. **K8s 完整清单已交付**（`deploy/k8s/`：StatefulSet + 入口 nginx + Nexus，见第 6
   节）；`moss-ingress.yaml` 降级为可选 TLS 前置/简化备选（cookie affinity 与 owner
   路由互斥，无 fencing 语义）。
9. **failover 后存量 runner 的 auth proxy 指向已死实例**：runner fencing 已交付——
   接管时旧 runner ≤10s 心跳失配自杀、新 owner respawn 注入新地址，该限制已按设计
   收敛为「fencing 后自愈」（时间线见第 5.4 节）。

---

## 5. 跨主机多实例部署（P3-1，`deploy/docker-compose.ha-crosshost.yml`）

### 5.1 拓扑

```
                      客户端 / 企微回调服务器
                              │
                 ┌──────── keepalived VIP 或云 SLB ────────┐
                 │            （LB 层冗余，见 5.3）          │
        ┌────────┴─────────┐                    ┌───────────┴──────┐
        │ 主机 A            │                    │ 主机 B            │
        │  nginx(双主机map) │◄── 跨主机 owner ──►│  nginx(同一份conf) │
        │  moss-server     │      路由可达       │  moss-server     │
        │  (host-a)        │                    │  (host-b)        │
        └───────┬──────────┘                    └────────┬─────────┘
                │            共享数据面（各主机挂载点一致）
        ┌───────┴──────────────────────────────────────────┴────────┐
        │  NFS: /data/moss/data（runtime/transcript）               │
        │  NFS: /data/moss/.moss（secrets/.master_key/kubeconfig）  │
        │  PostgreSQL（外部/托管实例，MOSS_DATABASE_URL）            │
        │  Nexus 主机（独立单实例，docker-compose.nexus-host.yml）   │
        └────────────────────────────────────────────────────────────┘
```

### 5.2 部署步骤（每台主机）

1. 前置：PG 就绪（14+；首启动自动建全量表）；NFS 两卷挂到**各主机相同路径**；
   Nexus 主机按 `deploy/docker-compose.nexus-host.yml` 起好并可达。
2. 拷贝 `deploy/` 目录；生成 `nginx/moss-crosshost.conf`（替换 `<HOST_A>/<HOST_B>`
   与 `host-a/host-b` 为实际 IP 与 `MOSS_INSTANCE_ID`——**两级 map 键 ==
   MOSS_INSTANCE_ID == 服务端 route 值**，任一不一致路由静默退化为 pool）。
3. `.env` 写入 `MOSS_INSTANCE_ID=host-a`（按主机命名，**必填**，漏配实例不下发
   route、其 runner 无 fencing）、`MOSS_DATABASE_URL`（含密码，仅 env，勿入库/盘）、
   `MOSS_PUBLIC_BASE_URL=http://<VIP或SLB>`、`MOSS_IMAGE_TAG`。
4. `docker-compose -f docker-compose.ha-crosshost.yml up -d`；另一台主机重复（仅
   `MOSS_INSTANCE_ID` 不同）。
5. 验证：`curl http://<VIP>/readyz`（200）；建 session 后确认响应 `ws_url` 带
   `?moss_route=<owner>` 且 owner 为创建实例。

### 5.3 LB 层冗余（二选一）

- **keepalived VIP**：两台主机各跑 `keepalived.conf.sample`（MASTER/BACKUP +
  pgrep nginx 健康检查，VIP 秒级漂移）；
- **云 SLB**：后端池 = 两主机 80 与 43128，健康检查 `GET /healthz`，**不需要**
  SLB 层会话保持（粘滞由 nginx 两级 map 完成）。

### 5.4 fencing 时间线与冷恢复预期

owner 主机故障的完整恢复链（默认 `MOSS_HEARTBEAT_TIMEOUT_MS=30000`）：

```
owner 主机死 ──► 存量 runner 心跳失配（≤10s，fencing 自杀）──► 实例心跳过期
（≤30s，DB 判死）──► 幸存实例 claim CAS 接管 ──► respawn（共享 transcript 续接）
```

- 运行中 turn **中断后冷恢复**（总窗口 ≈40-105s），长连接不无损迁移（与源设计
  文档 20 节一致）；客户端由首连/turn 兜底重试自愈（退避预算 121s 覆盖窗口）。
- 部署调大 `MOSS_HEARTBEAT_TIMEOUT_MS` 时上述时间线**等比拉长**。
- 源设计文档 6 节“明确提示用户 session 需恢复/重启”在本方案中被自动 fencing +
  冷恢复 + 客户端重试**自愈替代**（有意偏离，验收按 E2E 无 409 死循环为准）。

### 5.5 跨主机特有约束

- **NFS 挂载点路径字符串必须各主机一致**：attemptDir/transcriptPath/manifest 等
  被固化进共享文件与 PG，路径不同 = 接管方找不到文件。
- `MOSS_INSTANCE_ID` 必填（漏配 = 僵尸双写，见 compose 文头）。
- PG 是全新路径：不做 SQLite→PG 数据迁移（首版范围）。

## 6. K8s 部署（P3-2，`deploy/k8s/`）

清单与次序：

1. `moss-nexus.yaml` —— Nexus 单实例（vault 单写者，**replicas 必须为 1**，
   单点边界见文件头）；
2. `moss-server-statefulset.yaml` —— headless service + StatefulSet
   （`MOSS_INSTANCE_ID` 由 fieldRef 取 pod name）+ RWX PVC（runtime 与 MOSS_HOME
   两个卷，NFS StorageClass）+ PG 连接经 Secret `moss-pg`（key `url`）注入 +
   kubeconfig 经 Secret `moss-k8s-kubeconfig` 挂载（仅 k8s runtime 会话需要；
   moss 当前经 `kubectl --kubeconfig` 访问集群，in-cluster ServiceAccount 直连为
   后续优化项，届时该挂载可移除）；
3. `moss-nginx-route.yaml` —— 入口 nginx（ConfigMap 两级 map，upstream 指向
   `moss-server-<i>.moss-server-headless.<ns>.svc`）+ Service（80/43128）。

**扩缩容同步义务**：`replicas` 变化后必须同步 `moss-nginx-conf` 的三组 upstream
与两级 map 键（= pod name），再滚动重启 nginx Deployment——不同步则新 pod 不参与
owner 路由（WS 409 风暴）。

**TLS**：`moss-ingress.yaml` 作为可选前置挂 `moss-nginx` Service（此时删除其
affinity annotation，与两级 map 互斥；该文件头部注释已更新）。

**为什么不 Ingress 直连**：ingress-nginx 不支持按 query 路由到特定 pod，owner
精确路由（`?moss_route=`）必须由自管 nginx 完成。

## 7. 运维 SOP（P3-3）

### 7.1 升级 SOP

- 升级前对实例逐台 drain（`/readyz` 503 → nginx 摘流）并**终止活跃会话**，或明确
  声明升级窗口内 failover 需人工介入。理由：**detached runner 是长命进程**——
  升级重启后被复用的旧 runner 跑旧代码：旧心跳无条件 UPDATE 会覆写 fencing 条件
  （`runtime_state` 写回 running），fencing 对它失效、terminate 的停止标记被覆写，
  触发条件下（多实例 + 升级窗口附近 owner failover 且旧 runner 存活）会话僵死，
  只能登机清理（kill 旧 runner 进程 + 手工 `UPDATE session_attempts SET
  runtime_state='stopped'`）。
- 同版本卡死形态（一并登机清理）：runner 收到 shutdown 且 SIGTERM 已发但
  `handle.destroy(true)` 挂起——进程不退出、心跳继续成功 → 前台不阻塞但接管永不
  推进。触发面窄，登机 kill 即可。
- 滚动顺序：A drain → A 升级 → A ready → B drain → B 升级（保持任一时刻至少一
  实例接流量；跨主机/VIP 形态天然满足）。

### 7.2 首次部署：.master_key 首生成竞态

`.master_key` 是 loadOrCreate 语义（文件不存在则本地生成写回）。全新跨主机部署
若双主机并发首次执行 secret 操作，存在首生成竞态（后写者覆盖致先写者密文不可解）。
**SOP：首个 corp-app/secret 配置在单实例接流量状态下完成后再全量接流量**（一次性
动作，之后只读）。

### 7.3 低概率已知竞态（声明即可）

- `$MOSS_HOME/settings.json` 落共享 NFS 且 `writeFileSync` 非原子、模块级写串行化
  仅进程内：两实例并发保存系统设置存在丢失更新/读到半写文件的低概率竞态（低频管理
  场景；后续可改 tmp+rename 原子写）。
- Electron create 请求在 failover 切换瞬间若服务端实际成功而响应丢失，客户端重试
  会再次 create 产生孤儿 session（idle timeout 兜底回收；现状手动重试同样发生，
  自动重试仅略升频率）。

## 8. 单点边界汇总（如实声明）

moss 交付边界是**正确消费**下列共享组件；其自身 HA 属基础设施选型：

| 组件 | 边界 | 建议 |
|---|---|---|
| Nexus | 计划内单点（vault 单写者） | 独立主机 + `restart: always`；故障窗口内新建/轮换 secret 不可用（存量缓存不受影响） |
| LB/VIP | keepalived 抢主为计划内单点 | 云 SLB（多可用区）可消除 |
| NFS server | 自建 NFS 单点 | 云文件存储（多可用区）；自建分布式存储（Ceph 等）不在范围 |
| PostgreSQL | 自建 PG 单点 | 托管 PG / 多可用区；PG 集群（patroni 等）不在范围 |

owner 主机故障的会话级恢复见 5.4（fencing 冷恢复）；**运行中 turn 不无损迁移**是
设计边界（源文档 20 节）。
