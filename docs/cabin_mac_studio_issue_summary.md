# MOSS 客舱项目 Mac Studio 部署问题分析与修复说明

更新时间：2026-09-17

## 1. 背景

本次联调环境为 MOSS 客舱项目从 Linux ARM 服务器迁移到 Mac Studio Docker 环境后的现场部署环境。现场主要反馈两类问题：

1. MOSS session 对话偶发响应很慢，个别轮次出现 45 秒到 90 秒级等待。
2. 客舱 Skill 对模糊语义指令覆盖不完整，部分自然表达不能稳定触发正确工具调用。

联调过程中还发现并处理了以下相关问题：

- 服务重启后旧 runtime 容器残留，可能导致新对话无法正常启动。
- Mac Docker 环境下 SQLite 数据库存储方式不稳定，存在数据库损坏或状态不一致风险。
- 座位号回答中误把内部 ID 当成“排号”，出现“22 排 C 座”这类错误表达。

## 2. 问题一：MOSS session 对话慢

### 现象

现场日志中出现过如下现象：

- MOSS session reply timed out after 45000ms。
- 恢复后再次等待，单轮总耗时可达到约 90 秒。
- session attempt 中出现 attach socket unavailable、runner_pid no longer alive 等状态。
- 历史 runner stderr 中出现过连接本机模型服务失败的记录。

### 原因分析

该问题不是普通“模型推理慢”，也没有证据表明是 Docker 分配空间不足导致。

直接原因是 session runner 的生命周期和实际容器状态不一致：服务认为 session 可继续复用，但实际 runner socket 不可用或 runner 进程已经退出，导致请求等待到超时后才进入恢复逻辑。

迁移到 Mac Studio 后，该问题更容易暴露，主要风险点包括：

1. SQLite 数据库原先位于普通 bind mount 数据目录中，Mac Docker 文件同步场景下稳定性弱于 Docker volume。
2. 服务异常退出或宿主机关机重启后，旧的 `moss-user-*` runtime 容器可能残留。
3. 新对话创建时，如果容器名或 session 状态和数据库记录不一致，可能导致 runtime 创建、attach、恢复逻辑异常。
4. 旧版本对 session recovery、stale runtime 清理、数据库写入保护不够完整。

结论：数据库问题是重要风险点之一，但不是唯一原因。更准确地说，这是 Mac Docker 环境下“数据库持久化方式 + runtime 容器残留 + session 恢复机制”共同导致的稳定性问题。

### 修复方案

已从根本上做了以下修复：

1. 将 SQLite 数据库迁移到 Docker named volume：`moss-db:/app/db/moss.db`。
2. `server.json` 中数据库路径改为容器内稳定路径：`/app/db/moss.db`。
3. `start.sh` 启动时自动迁移旧数据库文件，并生成正确的宿主机路径映射。
4. 启动时自动处理残留的 `moss-user-*` runtime 容器，避免容器重名导致新会话无法创建。
5. 增强 session recovery，对 runner 丢失、terminated、stalled、detached 等状态进行更明确的恢复。
6. 对健康报告、自动化广播等后台写库链路增加保护，降低异常状态下数据库写入风险。
7. 部署脚本兼容 Docker Compose v2 和 v1，避免不同机器上 `docker compose` / `docker-compose` 命令差异导致启动失败。

相关提交：

- `d0e0ae0 Fix Mac deployment session recovery issues`
- `7d931cf Support Docker Compose v2 in deploy scripts`

## 3. 问题二：重启后旧 runtime 容器残留

### 现象

服务器关机或服务异常重启后，历史 runtime 容器仍存在。如果新会话继续使用相同命名规则创建容器，可能遇到容器名冲突，导致新对话无法启动。

### 原因分析

旧版本启动流程依赖服务自身正常关闭时清理 runtime 容器。但关机、Docker 异常退出、服务进程被强制停止等情况不会保证清理逻辑完整执行。

### 修复方案

启动脚本和 runtime registry 已增强：

- 服务启动时主动扫描并处理旧 `moss-user-*` 容器。
- 对残留容器进行 drain/cleanup，避免影响新 session。
- session recovery 逻辑中增加对丢失 runtime、不可 attach socket 的恢复处理。

该修复属于永久性方案，不依赖现场手工删除容器。

## 4. 问题三：模糊语义指令覆盖不完整

### 现象

现场测试中，一些自然表达可以正确触发工具，例如：

- “看书有点看不清”可映射到阅读灯调亮。
- “灯太刺眼”可映射到阅读灯调暗。
- “舱灯有点暗”可映射到顶灯亮度或颜色调整。

但部分模糊表达存在不稳定，例如：

- “舱里有点暗”
- “光线太暗”
- “帮我调整至办公模式”
- “我困了”“有点冷”“腰酸”等舒适状态表达

### 原因分析

客舱场景中，用户表达常常不是标准命令，而是状态描述或模糊诉求。旧 Skill 对这类表达的边界定义不够完整，模型可能出现以下问题：

1. 把“状态表达”误当成硬件控制命令，直接调用工具。
2. 把“办公/放松/睡眠/个人模式”误路由到硬件场景 `cabin.scene`，而不是业务模式切换接口。
3. 对灯光类表达中“阅读灯”和“客舱顶灯”的对象判断不稳定。
4. 对缺少关键参数的座椅调节可能直接猜测，而不是追问确认。

### 修复方案

已按“Skill 优先”的原则增强客舱助手和 Skill 规则：

1. 强化 `cabin-hardware-control` Skill 的命令映射、参数规则和禁止项。
2. 强化 `cabin-mode-switch` Skill，明确办公、放松、睡眠、个人模式必须走业务模式切换接口。
3. 在客舱助手规则中增加“状态表达主动反问”：
   - “我困了/累了”先询问是否需要放倒座椅。
   - “有点冷/凉”先询问是否需要座椅加热或毛毯。
   - “腰酸/背疼”先询问是否需要座椅按摩。
   - 用户确认后再调用硬件控制工具。
4. 对阅读灯、顶灯、座椅、桌板、通风、加热、按摩、生理检测等命令增加明确映射和默认参数。
5. 对硬件状态查询类问题单独走 `cabin-hardware-status-query`，避免把“现在是不是开着”误识别成“打开”。

相关提交：

- `8df65c9 Tighten cabin mode switch skill rules`
- `82a9191 fix cabin hardware parameter routing`

## 5. 问题四：座位号回答错误

### 现象

用户询问“我的座位号是多少？”时，系统曾回复：

> 您的座位号是 22 排 C 座。

但现场数据中：

- `seat_no = C` 才是面向乘客展示的座位号。
- `flight_seat_id = 22`
- `aircraft_seat_id = 22`

`flight_seat_id` 和 `aircraft_seat_id` 是内部绑定 ID，不是排号。

### 原因分析

模型看到 `flight_seat_id=22` 和 `seat_no=C` 后，按常见航空座位格式自行组合成了“22 排 C 座”。这是模型对字段语义的错误推断。

### 修复方案

已在三处增加约束：

1. 普通客舱回复 prompt 中明确：`seat_no` 是唯一可展示给乘客的座位号。
2. Moss session 每轮 prompt 中明确：`flight_seat_id`、`aircraft_seat_id`、`binding_id` 都是内部 ID，不得解释为排号。
3. `cabin-hardware-control` Skill 中同步增加座位展示规则，避免工具场景误用内部 ID。

新增测试覆盖了 `flight_seat_id=22`、`seat_no=C` 的场景，确保 prompt 明确禁止输出“22 排 C 座”。

相关提交：

- `c4800e2 Prevent internal seat ids in cabin seat replies`

注意：该修复需要重新打包并部署新的 server 镜像后才会在现场生效。


## 6. 当前验证结果

已完成的本地验证：

```bash
bun test src/server/cabin/__tests__/cabin-context.test.ts src/server/cabin/__tests__/cabin-moss-session.test.ts
git diff --check
bun run build:node
```

结果：

- 客舱上下文测试通过。
- Moss session recovery 测试通过。
- 座位号展示规则测试通过。
- Node 构建通过。
- 构建中仍有前端 chunk size warning，该警告为既有前端体积提示，与本次客舱修复无关。

服务器侧已验证：

- `moss-server` 可正常启动。
- 数据库使用 Docker volume 后完整性正常。
- 清空数据库后服务可重新生成数据。
- ASR 服务可访问。
- 硬件状态查询接口可到达。
- 部分硬件控制接口可成功返回，部分业务失败需硬件侧确认。

## 7. 部署建议

重新部署时建议按以下原则执行：

1. 使用最新打包的 server 镜像和 runtime 镜像。
2. 确保 `docker-compose.yml` 使用 `moss-db` named volume 挂载数据库。
3. 确保 `server.json` 中数据库路径为 `/app/db/moss.db`。
4. 不建议继续将 SQLite 主库放在 Mac Docker bind mount 数据目录中。
5. 保留启动脚本中的旧 runtime 容器清理逻辑。
6. 部署后先进行以下验证：
   - 服务健康检查。
   - `/v1/auth/token` 获取 token。
   - `/v1/ai-chat/send` 文本对话。
   - `/v1/voice/query` 语音识别。
   - 硬件状态查询。
   - 至少一条硬件控制指令。
   - 关机重启后再次创建新对话。

## 8. 总结

本次问题不是单一模型能力问题，也不是简单的 Docker 空间不足。核心问题分为两类：

1. Mac Studio Docker 部署环境下，数据库持久化、runtime 容器生命周期和 session recovery 需要更稳健的工程处理。
2. 客舱自然语言场景中，模糊表达、状态表达、业务模式和硬件控制之间的边界需要通过助手规则和 Skill 明确约束。

目前已完成代码和 Skill 层面的根因修复，并补充了关键测试。新的 server/runtime 镜像重新打包并部署后，可继续进行现场联调验证。
