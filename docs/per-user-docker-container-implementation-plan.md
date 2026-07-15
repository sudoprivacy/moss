# 用户级 Docker 容器 - 实现方案

配套设计文档：`docs/per-user-docker-container-design.md`。本文档只描述**怎么落地**，不重复设计取舍。

## 总览

总目标：从"每 session 一个 `docker run` 容器"过渡到"每用户一个长生命周期容器、每 session 一个 `docker exec scode`"，期间不破坏现有 API、不破坏 reconcile 路径、可灰度回滚。

阶段策略：

```text
A 阶段  共享 configDir 写并发整改 + busy 状态机
        独立落地, 老模式直接受益, 是新模式的前置
B 阶段  新模式的基础设施（配置项、DB schema、镜像脚本）
        不改变运行时行为
C 阶段  新模式的运行时实现（UserContainerRegistry、DockerBackend 新分支、reconcile）
        feature flag 后, 默认仍走老模式
D 阶段  灰度放量、监控、默认切换、老模式下线
```

ABCD 串行；阶段内可并行。

每个阶段都要满足"可独立合并 + 默认行为不变"。

---

## A 阶段：写并发整改 + busy 状态机

不引入用户级容器，只解决两个**老模式下也存在但被频率掩盖**的问题。完成后老模式更稳，新模式的基线也更干净。

### A1. Per-session 配置文件搬迁

**目标**：让 `sudocode.json` / `settings.json` / skill symlinks 不再写入共享 configDir。

**问题位点**：

```text
src/server/backends/dockerBackend.ts:186-214
  writeFileSync(<configDir>/.nexus/sudocode/sudocode.json, ...)
  writeFileSync(<configDir>/.nexus/sudocode/settings.json, ...)

src/server/backends/dockerBackend.ts:166
  createSkillSymlinks(configDir, enabledSkills)
```

**前置依赖已确认（读 scode 源码核实）**：

- scode CLI **没有** `--config` / `--mcp-config` 参数（`rusty-sudocode-cli/src/cli/args.rs`，全局 flag 只有 `--model / --auth / --output-format / --permission-mode / ...`）。
- scode 的 `config_home` 解析顺序（`runtime/src/config.rs::default_config_home()`）：
  ```
  SUDO_CODE_CONFIG_HOME (env) -> 用这个
  else $HOME/.nexus/sudocode
  ```
- scode 的 `ConfigLoader::discover()` 加载顺序（User > Project > Local 合并）：
  ```
  <config_home>/scode.json
  <config_home>/settings.json
  <cwd>/.scode.json
  <cwd>/.nexus/sudocode/settings.json
  <cwd>/.nexus/sudocode/settings.local.json
  ```
- `sudocode.json` 仅从 `<config_home>/sudocode.json` 读取（无 cwd-level 兜底）。
- moss 当前**未设** `SUDO_CODE_CONFIG_HOME`，scode 走 `$HOME/.nexus/sudocode` 路径；moss 设 `HOME=<configDir>` 把 config_home 间接拉到了共享 configDir 下，这就是 user-mode 写并发的根因。

**主方案（无需修改 scode）**：

利用现成的 `SUDO_CODE_CONFIG_HOME` 把 sudocode.json 和 User-level settings.json 移出共享 configDir：

- 新增 per-session 目录 `<runtimeDir>/sessions/<sid>/scode-home/.nexus/sudocode/`（路径名按 scode `default_config_home` 的子结构来）。
- per-exec env 增加：
  ```text
  SUDO_CODE_CONFIG_HOME=<runtimeDir>/sessions/<sid>/scode-home/.nexus/sudocode
  ```
- 把现在写到 `<configDir>/.nexus/sudocode/sudocode.json` 的内容改写到 `${SUDO_CODE_CONFIG_HOME}/sudocode.json`。
- 把现在写到 `<configDir>/.nexus/sudocode/settings.json` 的 MCP 配置改写到 `${SUDO_CODE_CONFIG_HOME}/settings.json`。
- `HOME=<configDir>` **保留不变**——agent override、shared memory 路径仍按现状（`CLAUDE_CODE_REMOTE_MEMORY_DIR=<configDir>` 控制），它们与 `SUDO_CODE_CONFIG_HOME` 解耦。
- `createSkillSymlinks(configDir, enabledSkills)` 在 `dockerMode=user` 下改为写到 `${SUDO_CODE_CONFIG_HOME}/skills/...`（per-session），或者直接删除这条，让 scode 仅通过 `syncWorkspaceSkills(workspace, ...)` 的 workspace 链接发现 skill。后者更简洁，但需要确认 scode 的 plugin 解析能从 workspace 找到 skill。
- 销毁 session 时连带清理 `<runtimeDir>/sessions/<sid>/scode-home/`。

**辅助优化（可选）**：

- MCP `settings.json` 也可以同时落到 `<workspace>/.nexus/sudocode/settings.json`（Project source），scode 会自动 deep-merge。优点：即使 `SUDO_CODE_CONFIG_HOME` 没改对，workspace 这份也能兜底。但要小心两份同时存在时的合并语义。第一版不推荐叠加，保持单一来源。

**`memory_mode=user` 下的 agent override 写入**：

- 写入路径仍是 `<users>/<uid>/config/.moss/memory/<assistantName>/AGENTS.md` 这类用户级文件，由 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 控制，与 `SUDO_CODE_CONFIG_HOME` 解耦，不受 A1 主方案影响。
- 改用：
  - `fs.open(path, 'wx')` 创建 lockfile（`<path>.lock`），写完 rename 删 lock；
  - 或基于 `proper-lockfile` 之类的库（如果项目已有依赖）。
- 写入步骤改为 `tempfile + rename`：写 `<path>.tmp.<pid>.<rand>`，`fs.rename(tmp, target)` 原子替换。

**skill 发现路径验证（落地前必做）**：

- 在 A1 PR 里加一个集成测试：启用 `SUDO_CODE_CONFIG_HOME=<per-session>`，确保 scode 启动后能发现 enabled skills（通过 `scode skills list` 或 ACP 命令验证）。
- 如果 scode 的 plugin 路径解析对裸名称走 `config_home`，但 skills 实际安装在 `<workspace>/.nexus/sudocode/skills/`，可能需要在 `${SUDO_CODE_CONFIG_HOME}` 下也建一份 skill 链接，或者推动 scode 支持 workspace skill 发现。这是 A1 唯一可能受阻的点。

**修改文件清单**：

```text
src/server/backends/dockerBackend.ts        改文件写入路径 + per-exec 加 SUDO_CODE_CONFIG_HOME
src/server/backends/backendUtils.ts         新增 buildSessionScodeHomeDir() 辅助
src/server/backends/acpBridge.ts            destroy 时清理 scode-home 目录(若 host 模式)
src/server/agentStore.ts                    agent override 写入加锁 + 原子 rename
src/server/__tests__/scode-config-home.test.ts   新增: 验证 SUDO_CODE_CONFIG_HOME 路径生效
                                                       验证 skill 发现路径
deploy/runtime/Dockerfile                   无需改动
```

**验收**：

- 新增测试：dockerMode=user 下两个 session 并发 spawn，A 写入的 sudocode.json 不被 B 覆盖（断言 A、B 各自读到自己的内容）。
- 新增测试：agent override 并发写不出现半写文件（用大量小写入 stress test，校验 JSON 始终可解析）。

---

### A2. Busy 状态机

**目标**：把"不活跃 session"的判定从"无 socket"升级为"无 socket **且** 无任务在跑"。`idleTimeoutMs` 改为"自 (detached && !busy) 同时成立起算"，避免任务刚跑完就被立即 kill。

**问题位点**：

```text
src/server/sessionManager.ts:382-392        #armIdleTimeout(record): 只按 sockets.size 判定
src/server/sessionRunnerDaemon.ts:399-420   runner 内的 idle 检测: 同样仅按 #clients.size
src/server/backends/acpBridge.ts:431        parsed.result?.stopReason 是 turn 完成信号
src/server/backends/acpBridge.ts:61-76      pendingAskUserQuestions 是唯一可靠的 "等待用户"信号
                                            toolResultIdByToolCallId / currentTurnToolCalls 不可作为 pending tool
```

#### A2-1. `BackendHandle` 接口扩展

把 busy 提升到 backend 抽象层，让 runner 能订阅：

```text
BackendHandle 新增:
  isBusy(): boolean
  onBusyChange(listener: (busy: boolean) => void): () => void
  persistInProgressTurn(): Promise<void>   // 兜底: 在 maxDetachedBusyMs kill 前
                                            // 把当前 currentAssistantText 写入 transcript
                                            // 并写一条 'killed_by_idle_busy_timeout' 事件
```

DockerBackend / HostBackend 不引入新状态，原样透传 AcpBridge 暴露的接口。

#### A2-2. AcpBridge 内部 busy 状态机

```text
内部状态:
  #busy: boolean
  #busyListeners: Set<(busy: boolean) => void>
  #pendingStdinQueue.length  (复用已有 pendingStdin)

setBusy(next):
  if next === #busy: return
  #busy = next
  for l of #busyListeners: l(next)

busy = true 触发 (任一成立即 true):
  - writeStdin 入口被调 (无论走 processUserMessage 还是 pendingStdin buffer)
    -> 在 writeStdin 顶部 setBusy(true)
  - pendingAskUserQuestions 非空 (有等待用户回答的提问)
    -> add 时 setBusy(true)

busy = false 触发 (同时满足):
  - 收到 parsed.result?.stopReason (参考 acpBridge.ts:431 现有判定路径)
  - 且 pendingAskUserQuestions 为空
  - 且 pendingStdin (buffer) 为空
  -> stopReason 处理末尾调 reevaluateBusy()

scode 退出:
  setBusy(false)  // 给 runner 一个干净的最终状态

关键: 不要把 toolResultIdByToolCallId / currentTurnToolCalls / pendingRpcRequests
作为 busy 判定依据:
  - toolResultIdByToolCallId 是 id 映射, 只增不删
  - currentTurnToolCalls 只在 stopReason 时整体 clear, 中间 size>0 不代表"还有 tool 跑"
  - pendingRpcRequests 是 moss→scode 的短命 RPC (如 m-set-model),
    跟 turn 状态无关
  scode 在 stopReason 一并 flush turn 内全部 tool calls (acpBridge.ts:437-456),
  stopReason 就是 "本 turn 全部已落地" 的权威信号.
```

#### A2-3. Idle / busy ceiling 计时算法

`SessionRecord` 扩字段（**busy 在 record 上持有**，订阅 `onBusyChange` 时同步写入 `record.busy`，reschedule 同步读取）：

```text
SessionRecord 扩字段:
  busy:                 boolean
  detachedSince:        number | null
  notBusySince:         number | null
  detachedBusySince:    number | null
  idleTimer:            Timer | null  // 取代旧 timeout
  busyCeilingTimer:     Timer | null
  busyUnsubscribe:      (() => void) | null
```

事件触发点（**任一发生都要重算**计时器，写成单一 `reschedule(record)` 函数）：

```text
事件:
  - socket attach   -> detachedSince = null
  - socket detach   -> sockets.size===0 时 detachedSince = now;
                       若同时 busy 则 detachedBusySince = now
  - busy true→false -> notBusySince = now; detachedBusySince = null
  - busy false→true -> notBusySince = null;
                       若 detachedSince 非空且 detachedBusySince 为空 则 detachedBusySince = now

reschedule(record):
  cancel idleTimer; cancel busyCeilingTimer

  if record.sockets.size > 0: return

  if !record.busy:
    // 客户端断开 且 任务空闲, 才开始 idleTimeoutMs
    base = max(record.detachedSince, record.notBusySince ?? record.detachedSince)
    remaining = max(0, idleTimeoutMs - (now - base))
    arm idleTimer for remaining:
      on fire -> handle.destroy(force=true)
    return

  // sockets.size === 0 && busy: 仅兜底 busy ceiling
  remaining = max(0, maxDetachedBusyMs - (now - record.detachedBusySince))
  arm busyCeilingTimer for remaining:
    on fire ->
      emit metric 'idle_busy_timeout_total'
      await handle.persistInProgressTurn()    // 写下未持久化的 partial output
      handle.destroy(force=true)
```

要点：

- `idleTimer` 只在 (detached && !busy) 同时成立时 arm；任一条件翻转立即取消。
- `busyCeilingTimer` 只在 (detached && busy) 同时成立时 arm，busy→false 取消后由 idleTimer 接力（不叠计）。
- AskUserQuestion 期间 busy=true，意味着用户离线且不答时，最终由 `busyCeilingTimer` 兜底回收。`persistInProgressTurn()` 保证 partial agent text 不丢。

#### A2-4. SessionManager / SessionRunnerDaemon 接入

```text
src/server/sessionManager.ts:
  - SessionRecord 加上述字段
  - constructor 时调 handle.onBusyChange(busy => { record.busy = busy; reschedule(record) })
  - attachSocket / socket close 改触发 reschedule(record)
  - destroySession 时 busyUnsubscribe?.()
  - 删除 #armIdleTimeout, 改为 reschedule(record)

src/server/sessionRunnerDaemon.ts:
  - #armIdleTimer 同样重写为 reschedule()
  - 订阅 handle.onBusyChange (类似 SessionManager)
  - 注意: runner 和 SessionManager 都在各自进程, 各自维护 timer.
          为避免双杀, 让 runner 负责 scode 进程级 idle, SessionManager 仅做 socket 级状态广播.
          实现上: SessionManager 不再 destroy session, 改为通知 runner.
```

> 上面"SessionManager 不再 destroy session"是迁移性改动。当前 SessionManager 的 idle 判定会直接 `destroySession`，改成"reschedule 等 runner 判定"。这避免主进程和 runner 两套定时器竞赛。如果改动面太大，至少保证两边的阈值和判定一致（用同一份 reschedule 函数实现）。

#### A2-5. 配置新增

```text
runtimeDefaults.idleTimeoutMs     现有, default 10 * 60 * 1000  (10 分钟)
                                  scode 进程级 idle: detached && !busy 起算
session.maxDetachedBusyMs         default 2 * 60 * 60 * 1000   (2 小时)
                                  detached && busy 兜底
docker.userContainerIdleTimeoutMs default 20 * 60 * 1000        (20 分钟)
                                  用户容器 idle (activeSessionIds.size === 0) 起算
docker.maxSessionsPerUser         default 5
                                  单用户并发 scode 上限
docker.execKillGraceMs            default 5000
                                  reaper SIGTERM → SIGKILL 等待
```

> 配置入口都在 `server.json`/环境变量；`config.ts::readServerConfig` 映射到
> `ServerConfig`。runner 通过 manifest 拿 `idleTimeoutMs` 和 `session.maxDetachedBusyMs`，
> 主进程拿 `docker.*` 控制 UserContainerRegistry。

#### A2-5b. Sudowork detach vs Moss terminate 语义

新增 Sudowork 客户端"idle detach"行为：客户端只断 WS，不调用 `/terminate`；只有
删除会话才调用 `/terminate`。Moss 必须严格区分：

```text
WS close (detach):
  - runner #clients 减 1 → reschedule()
  - status='detached', desired_state='active'
  - 不调 terminateSession，不 markSessionEnded(terminated, ...)

idle/busy ceiling fires (scode 被 server 端 idle 杀):
  - markSessionEnded(status='ended', desired_state='active')
                                          ^^^^^^^^^ key: 可 resume
  - ended_at = now (informational)
  - 主进程 child.once('close') → registry.releaseSession
  - listSessionsToRecover 自动跳过 status='ended' 行 (不重启 scode)

POST /api/v1/sessions/:id/resume 或 WS reattach:
  - ensureSessionReady → ensureAttempt → probe fail → spawnAttempt
  - reactivateSession(): ended_at=NULL, status='active', desired='active'
  - 新 attempt, transcriptPath 不变, 新 generation

POST /api/v1/sessions/:id/terminate (客户端删除会话):
  - setSessionLifecycle(terminated, terminated)
  - SIGTERM runnerPid
  - 无条件 markAttemptStopped(stopped, reason='terminated')
    (即便 SIGTERM 成功，runner 自己的 onExit 写终态是异步的；若 runner 之后
     SIGKILL 或崩溃，主进程这边的 markAttemptStopped 已经把 row 写到终态)
  - runner onExit: status='terminated', desired_state='terminated'

reconcileOnStartup 兜底:
  - listAttemptsByRuntimeState(['starting','running','detached'])
  - runner_pid 为空或 process.kill(pid, 0) 失败 →
      markAttemptStopped(stopped, reason='stale_on_startup')
  - 防止 DB 长期残留脏 attempt
```

#### A2-6. 修改文件清单

```text
src/server/backends/acpBridge.ts        新增 #busy 状态机 / setBusy / reevaluateBusy
                                        + isBusy / onBusyChange / persistInProgressTurn
                                        + stopReason 路径调 reevaluateBusy
                                        + writeStdin 入口 setBusy(true)
                                        + pendingAskUserQuestions add/delete 触发重算
src/server/sessionManager.ts            SessionRecord 扩字段; reschedule() 算法;
                                        订阅 onBusyChange; idle 改为通知 runner 而不是直接 destroy
src/server/sessionRunnerDaemon.ts       #armIdleTimer 重写为 reschedule();
                                        订阅 onBusyChange; flush + destroy 顺序保证
src/server/types.ts                     maxDetachedBusyMs 配置项
src/server/__tests__/busy-state.test.ts 新增 (见下)
```

#### A2-7. 验收用例

**必须覆盖 5 类时序，第一条是关键 regression**：

1. **任务跨过 idleTimeoutMs 才完成 — 不应立即 kill（核心 regression）**
   ```text
   T0       attach socket; processUserMessage; busy=true
   T0+9min  detach socket; detachedSince=T0+9min
            (busy=true, 故不 arm idleTimer; arm busyCeilingTimer)
   T0+19min 仍 busy; idleTimer 仍未 arm
   T0+19min+1s  scode 发出 stopReason; pendingAskUserQuestions 空 → busy=false
                notBusySince=T0+19min+1s
                reschedule: arm idleTimer with full idleTimeoutMs (10min)
                  断言 idleTimer remaining ≈ 10min, 而非 0
   T0+29min+1s  idleTimer 到期 → destroy
   ```

2. **detached + 持续 busy → busyCeiling 兜底 + flush**
   ```text
   T0       detach, busy=true 持续
   T0+maxDetachedBusyMs  busyCeilingTimer 到期:
                          断言 handle.persistInProgressTurn 被调
                          断言 metric 'idle_busy_timeout_total' +1
                          断言 destroy(force=true) 被调
   ```

3. **busy 来回翻转，timer 正确取消/重算**
   ```text
   detach -> busy=true (busyCeiling arm)
          -> stopReason → busy=false (busyCeiling cancel, idleTimer arm)
          -> processUserMessage → busy=true (idleTimer cancel, busyCeiling re-arm,
                                              detachedBusySince 重置为现在)
          -> stopReason → busy=false (idleTimer 重新 arm full idleTimeoutMs)
   ```

4. **AskUserQuestion 期间用户离线**
   ```text
   detach 后 scode 发出 ask_user_question
   断言 pendingAskUserQuestions 非空 → busy=true
   断言 不 arm idleTimer
   断言 仅 arm busyCeilingTimer
   maxDetachedBusyMs 到期 → persistInProgressTurn + destroy
   ```

5. **重新 attach 取消所有 timer**
   ```text
   detach + busy=false → idleTimer arm
   T+5min reattach socket
   断言 idleTimer / busyCeilingTimer 都 cancel
   detach 后重新 arm 时 base = 新的 detachedSince/notBusySince
   ```

集测（端到端）：

- 长任务（≥ idleTimeoutMs）运行中关掉 web 页面，scode 不被回收。任务完成后用户在 idleTimeoutMs 内回来 reattach，能拿到完整 transcript。
- 同上但用户不回来，过 idleTimeoutMs 后被回收。
- AskUserQuestion 出现后用户不答，过 maxDetachedBusyMs 被回收，transcript 包含 partial agent text + killed_by_idle_busy_timeout 事件。

---

### A3. Transcript 路径迁移

**目标**：把 transcript 从 configDir 内迁到独立目录，让 session destroy 时清 configDir 不会带走历史 transcript。

**背景与问题**：

- 当前 transcript 路径由 `runtimePaths.ts:81-87` 的 `getTranscriptPath(configDir, cwd, sessionId)` 算出，落到 `<configDir>/projects/<sanitized-cwd>/<tsid>.jsonl`。
- `dockerBackend.ts:316-335` 老路径 cleanup 在 `mode === 'session'` 时 `rm -rf configDir`——**transcript 跟着删掉**。
- 现状 API 受影响范围：
  - `GET /api/v1/sessions/:id/context`（`transcript.ts:100, 135`）依赖 `session.transcriptPath` 文件存在。
  - `budgetStats.ts:330` `collectUsageFromTranscriptFile`、`dashboardStats.ts:114` `mainTranscriptPath` 同样依赖。
- 这是**老模式既有行为**，不是新方案引入。但新方案下 user-mode 共享 configDir 不删（transcript 保住），session-mode 仍删（transcript 丢）；语义不一致会让 reviewer 困惑。

**新路径**（独立目录，与 configDir 解耦）：

```text
<runtimeDir>/sessions/<sessionId>/transcript/<transcriptSessionId>.jsonl
              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
              不含 projects/<sanitized-cwd> 子目录, 因为已经按 sessionId 隔离
              不在 configDir 下, destroy 时不删
```

**改动点**：

1. **路径函数改造** —— `src/server/runtimePaths.ts::getTranscriptPath` 改签名：

   ```text
   getTranscriptPath(
     runtimeDir: string,       // 新增 (现状: configDir)
     sessionId: string,        // moss session id
     transcriptSessionId: string,
   ): string {
     return join(runtimeDir, 'sessions', sessionId, 'transcript', `${transcriptSessionId}.jsonl`)
   }
   ```

   所有调用方（`runtimeService.ts:467`、`sessionRunnerDaemon.ts:456-462`）同步改参数。`cwd / sanitizePath(cwd)` 不再参与路径——因为 sessionId 已经唯一隔离。

2. **挂载路径** —— DockerBackend 在 `containerMode=user` 下挂 `<runtimeDir>` 根（A1 之后已经如此），transcript 目录天然在容器内可见。session 模式下需要额外把 `<runtimeDir>/sessions/<sid>/transcript` 加入挂载列表（或者直接挂 `<runtimeDir>/sessions/<sid>` 父目录）。

3. **历史数据迁移脚本** —— 启动时一次性迁移：

   ```text
   scripts/migrate-transcript-paths.ts
     - 扫 DB sessions.transcript_path
     - 对每条:
         if 老路径 (<configDir>/projects/.../<tsid>.jsonl) 存在 且 新路径不存在:
           mkdir -p <runtimeDir>/sessions/<sid>/transcript/
           cp <old> <new>     // 用 cp 而非 mv, 失败可回退
           verify size + first/last line 一致
           UPDATE sessions SET transcript_path = <new> WHERE id = ?
           rm <old>           // 全部成功后才删
         elif 新路径已存在:
           noop (重启再跑可重入)
         else:
           // 老路径已不存在 (session 模式 destroy 后), 已经丢了, 跳过
           日志: 'transcript_already_lost', sessionId, oldPath
   - 迁移失败的 session 保留老 transcript_path, 标记 metric 'transcript_migrate_failed_total'
   - 不阻塞 moss-server 启动: 主流程异步触发, 进度写状态文件
   ```

4. **A3 PR 与 A1 解耦**：transcript 迁移独立于 A1 的 `SUDO_CODE_CONFIG_HOME` 改造。两者可并行 review，串行合并（A3 先合，A1 后合，避免 A1 cleanup 把还没迁移的 transcript 删掉）。

**修改文件清单**：

```text
src/server/runtimePaths.ts                              改 getTranscriptPath 签名
src/server/runtimeService.ts                            getTranscriptPath 调用 + 新签名
src/server/sessionRunnerDaemon.ts                       maybeUpdateTranscriptSession 用新签名
src/server/backends/dockerBackend.ts                    挂载列表加 transcript 目录 (session 模式)
src/server/transcript.ts                                若有路径解析硬编码, 同步
src/server/budgetStats.ts                               同上 (扫一遍 transcriptPath 使用点)
src/server/dashboardStats.ts                            同上
scripts/migrate-transcript-paths.ts                     新增迁移脚本
src/server/__tests__/transcript-path-migration.test.ts  新增迁移单测
```

**验收**：

- 单测：迁移脚本对已迁移、未迁移、丢失三种状态都幂等。
- 单测：迁移过程中断（kill 模拟），状态文件保留，下次启动从断点继续。
- 单测：`getTranscriptPath` 新签名返回 `<runtimeDir>/sessions/<sid>/transcript/<tsid>.jsonl`。
- 集测：A3 合并后跑一遍现存 session：
  1. destroy 一个老格式 session → transcript 已迁移 → `GET /sessions/:id/context` 仍可读。
  2. destroy 一个新格式 session → configDir 删除但 transcript 目录保留 → API 仍可读。
- 集测：跨重启迁移：moss-server 启动后 1 分钟内 mock kill -9，重启后剩余 session 继续迁移。

**风险**：

- 迁移失败的 session 转 transcript 丢失（实际未发生，但 DB 路径仍指向老位置）——脚本必须**保守**：先 cp、verify、改 DB、最后 rm，任一步失败回滚。
- 老路径有 `projects/<sanitized-cwd>` 子目录，新路径没有——若 UI 或其他工具依赖 cwd 信息从路径推断，需要改用 DB `cwd` 字段。
- 大量历史 session 一次性迁移 IO 压力——脚本支持 `--batch-size` 和 `--rate-limit`。

---

## B 阶段：新模式基础设施

不改变运行时路径，只准备好配置、schema 和镜像里要用的东西。

### B1. 配置项

新增 `RuntimeConfig`（在 `src/server/types.ts`）：

```text
docker.containerMode: 'session' | 'user'   default 'session'
docker.maxSessionsPerUser: number          default 5
docker.userContainerIdleTimeoutMs: number  default 20 * 60 * 1000
docker.execKillGraceMs: number             default 5000
docker.stopTimeoutSec: number              default 10
docker.user.pidsLimit: number              default 512
docker.user.memory: string                 default '4g'
docker.user.cpus: string                   default '2'
docker.user.nofile: number                 default 4096

session.maxDetachedBusyMs: number          default 2 * 60 * 60 * 1000   (A2 同步加)
```

`containerMode` 是 feature flag，整个 C 阶段开发期间默认 `'session'`。

#### server.json 配置方式

新增运行策略配置都走 `server.json` 的 `docker` 段。部署时如果 moss-server 通过
`MOSS_SERVER_CONFIG=/app/server.json` 启动，并且 compose 已经把宿主机的
`./server.json` 挂载到 `/app/server.json`，则开启用户级容器只需要改
`server.json`，不需要为了这些新增字段修改 `docker-compose.yml`。

示例：

```json
{
  "runtimeDefaults": {
    "type": "docker",
    "engine": "scode",
    "dockerImage": "my-moss-runtime:v1",
    "dockerMode": "session",
    "scodePath": "/usr/local/bin/scode",
    "idleTimeoutMs": 600000,
    "maxSessions": 32
  },
  "docker": {
    "network": "moss-network",
    "stopTimeoutSec": 10,
    "labels": {},
    "containerMode": "user",
    "maxSessionsPerUser": 5,
    "userContainerIdleTimeoutMs": 1200000,
    "execKillGraceMs": 5000,
    "user": {
      "pidsLimit": 512,
      "memory": "4g",
      "cpus": "2",
      "nofile": 4096
    }
  }
}
```

字段说明：

- `docker.containerMode`: 容器复用边界。`session` 保持旧逻辑；`user` 开启每用户一个长生命周期容器。
- `docker.network`: 用户容器创建时加入的 Docker 网络。容器化部署中如果 `MOSS_AUTH_PROXY_URL=http://moss-server:12013`，这里必须配置为 compose 网络（例如 `moss-network`），保证用户容器能解析并访问 `moss-server`。
- `docker.maxSessionsPerUser`: 同一用户容器内允许并发的 session / `scode` 进程上限。
- `docker.userContainerIdleTimeoutMs`: 用户没有任何 active session 后，等待多久销毁用户容器，单位毫秒。
- `docker.execKillGraceMs`: 终止单个 session 的 `scode` 进程组时，TERM 到 KILL 之间的等待时间，单位毫秒。
- `docker.user.*`: 用户级容器资源闸门，控制进程数、内存、CPU 和 fd 上限。

`session.maxDetachedBusyMs` 当前由服务端默认值提供，现阶段不是 `server.json`
可配置字段；如需暴露给部署配置，需要补 `serverFileConfigSchema.session` 解析。

**修改文件清单**：

```text
src/server/types.ts                     新增字段
src/server/startStandaloneServer.ts     加载配置, 校验互斥
deploy 默认配置 / 环境变量映射          按部署形态决定
```

### B2. DB schema 演进

新字段（写到 sessions 表，或 attempts 表，按现有 schema 决定）：

```text
session_runtime_info JSON 内部扩展:
  containerMode:        'session' | 'user'
  userContainerName:    string | null
  inContainerPidFile:   string | null
  tmpDirInContainer:    string | null
```

迁移策略：

- 老数据 `containerMode` 字段缺失 → 启动时视为 `'session'`，沿用现有 reattach/resume 流程。
- 不新增表，直接在 JSON 字段里加 key（零迁移风险）。
- 文档化字段含义。

**修改文件清单**：

```text
src/server/db.ts                        SessionRuntimeInfo 类型扩字段
src/server/sessionManager.ts            读写新字段时兼容缺失
src/server/runtimeService.ts            reconcile 读取兼容
```

**验收**：

- 单测：用旧格式 JSON 启动，正确识别为 `containerMode='session'`，不报错。
- 单测：用新格式 JSON 启动，字段正确解析。

### B3. 容器内 launcher / reaper 脚本

#### 镜像依赖约束（落地前必须确认）

launcher / reaper 依赖以下容器内组件，**当前 Ubuntu 24.04 基础镜像全部满足**，但若未来换基础镜像（Alpine、distroless 等）会悄无声息坏掉。Dockerfile 与 CI 必须显式验证：

| 依赖 | 用途 | Ubuntu | Alpine | distroless |
|---|---|---|---|---|
| `setsid` (util-linux) | 建立独立 process group，按 PGID 杀树 | ✓ | 需 `apk add util-linux` | ✗ 需另寻方案 |
| GNU `sleep` (coreutils) 支持小数 (`sleep 0.5`) | reaper 按 grace_ms 等待 | ✓ | BusyBox `sleep` **不支持小数** | ✗ |
| `awk` | 解析 `/proc/<pid>/stat` 第 22 字段 | ✓ | ✓ | ✗ |
| `/proc/<pid>/stat` 第 22 字段（starttime） | PID 复用对账 | ✓（Linux 必有） | ✓ | ✓ |
| `kill -- -PGID` 语法 | 杀整个 process group | ✓（POSIX） | ✓ | ✓ |
| `/bin/sh` (dash 或 ash 都行) | 解释 shell 脚本 | ✓ | ✓ | ✗ |

Dockerfile 改动：

```text
deploy/runtime/Dockerfile:
  # 现状: FROM ubuntu:24.04
  # util-linux / coreutils / mawk 在 ubuntu 默认镜像已装, 不需要 apt install
  # 仅显式声明依赖检测
  RUN command -v setsid && \
      sleep 0.001 && \             # 验证 sleep 支持小数
      command -v awk && \
      [ -r /proc/self/stat ] && \
      echo 'image deps ok'
  COPY moss-session-launch.sh /usr/local/bin/moss-session-launch
  COPY moss-session-reap.sh   /usr/local/bin/moss-session-reap
  RUN chmod +x /usr/local/bin/moss-session-launch /usr/local/bin/moss-session-reap
```

CI 任务额外加一步独立 dependency 检测脚本（拉构建后的镜像跑一次），任何依赖缺失立即 fail，不让坏镜像进 release 流程。

#### 脚本本体

新文件：

```text
deploy/runtime/moss-session-launch.sh
deploy/runtime/moss-session-reap.sh
```

**关键单位约定**：reaper 通过 `/proc/<pid>/stat` 第 22 字段（**clock ticks since boot**，单位 USER_HZ）做 PID 复用校验。launcher 必须用**同源单位**写入对账文件，**不能用 `date +%s%N`（墙钟纳秒，参考点是 epoch）**。两者单位、参考点、刻度均不同。

`moss-session-launch.sh`：

```sh
#!/bin/sh
set -e

SID="$1"; shift              # 取 session id 并从参数列表移除
if [ "${1:-}" != "--" ]; then
  echo "usage: moss-session-launch <sid> -- <cmd...>" >&2
  exit 2
fi
shift                        # 跳过分隔符 --

RT_DIR="${MOSS_RUNTIME_DIR:-/data/runtime}"
META="$RT_DIR/sessions/$SID/runtime"
mkdir -p "$META"

echo "$SID" > "$META/scode.session_id"

# setsid 单独建立 process group; 内层 shell 写 pidfile + start_ticks 后 exec scode.
# 写 start_ticks 必须在 exec 之前; exec 不改变 PID 也不改变 starttime,
# 所以 reaper 后续读 /proc/<pid>/stat 第 22 字段时单位/数值都对得上.
exec setsid sh -c '
  PID=$$
  echo "$PID" > "'"$META"'/scode.pid"
  awk "{print \$22}" "/proc/$PID/stat" > "'"$META"'/scode.start_ticks"
  exec "$@"
' _ "$@"
```

`moss-session-reap.sh`：

```sh
#!/bin/sh
set -e

SID="$1"
GRACE_MS="${2:-5000}"

RT_DIR="${MOSS_RUNTIME_DIR:-/data/runtime}"
META="$RT_DIR/sessions/$SID/runtime"
PIDFILE="$META/scode.pid"
TICKSFILE="$META/scode.start_ticks"

[ -f "$PIDFILE" ] || { echo "no pidfile"; exit 0; }

PID=$(cat "$PIDFILE")

# 进程已退出 -> 仅清理元数据
if [ ! -r "/proc/$PID/stat" ]; then
  echo "pid $PID already gone"
  rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"
  exit 0
fi

# PID 复用校验 (同单位: /proc/.../stat 第 22 字段, clock ticks since boot)
if [ -r "$TICKSFILE" ]; then
  CUR_TICKS=$(awk '{print $22}' "/proc/$PID/stat")
  REC_TICKS=$(cat "$TICKSFILE")
  if [ "$CUR_TICKS" != "$REC_TICKS" ]; then
    echo "pid $PID start_ticks mismatch (cur=$CUR_TICKS rec=$REC_TICKS), skip kill"
    rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"
    exit 0
  fi
fi

# 按 PGID 杀树 (前导 - 表示 process group)
kill -TERM -- -"$PID" 2>/dev/null || true

SLEEP_S=$(awk -v ms="$GRACE_MS" 'BEGIN { print ms/1000 }')
sleep "$SLEEP_S"

if kill -0 "$PID" 2>/dev/null; then
  kill -KILL -- -"$PID" 2>/dev/null || true
fi

rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"
```

> launcher / reaper 全程用 `/proc/<pid>/stat` 第 22 字段做对账，单位一致、容器内无依赖（无需 `date` 的 `+%N` 扩展、无需考虑容器时区）。

Dockerfile 改动：

```text
deploy/runtime/Dockerfile:
  COPY moss-session-launch.sh /usr/local/bin/moss-session-launch
  COPY moss-session-reap.sh   /usr/local/bin/moss-session-reap
  RUN chmod +x /usr/local/bin/moss-session-launch /usr/local/bin/moss-session-reap
```

**验收**：

- **CI 镜像依赖检测**：`docker run <image> sh -c 'command -v setsid && sleep 0.001 && command -v awk && [ -r /proc/self/stat ] && echo ok'` 必须 exit 0。任一依赖缺失，镜像构建标记 fail。
- 容器内手测：`moss-session-launch test-sid -- sleep 100 &`，`moss-session-reap test-sid 1000`，验证 sleep 进程被杀、pidfile / start_ticks / session_id 被清。
- 手测：scode fork bash 子进程后被 reap，所有子进程同时退出（PGID 杀树）。
- 手测：手动改 `scode.pid` 指向已退出的 PID 然后启动一个新的 sleep（让内核复用 PID），reaper 应识别 `start_ticks` 不匹配，跳过 kill 并清元数据，不误杀新进程。
- 手测：`scode.start_ticks` 与 `cat /proc/$(cat scode.pid)/stat | awk '{print $22}'` 数值一致（同单位对账）。
- 手测：reaper 在 `kill -0` 仍存活时进入 `--grace-ms` 等待，超时后发 SIGKILL。
- 手测：launcher 不带 `--` 时 exit 2 并打印 usage（防御性参数解析）。
- 手测：reaper 接受小数 grace_ms（如 `2500`），`sleep $(awk 'BEGIN{print 2500/1000}')` = `sleep 2.5` 在 GNU sleep 下正常等待。

---

## C 阶段：新模式运行时

### C1. UserContainerRegistry

**新文件**：`src/server/runtime/userContainerRegistry.ts`

**职责**：

- 维护 `Map<key, UserContainerRecord>`（key = `${orgId}:${userId}`）。
- `ensureUserContainer(orgId, userId): Promise<UserContainerHandle>`，含 per-key 锁。
- `releaseSession(orgId, userId, sessionId)` 引用计数减一，触发或重置 idle timer。
- `acquireSession(orgId, userId, sessionId)` 计数加一，取消 idle timer。
- `tryReclaimIdle(key)` 在状态 `running` + 引用计数 0 + idle 超时下进入 `draining`，执行 `docker stop` + `docker rm`。
- `reconcile()` 启动时从 `docker ps --filter label=moss.kind=user-container` 重建 registry。

**数据结构**：

```typescript
type UserContainerState = 'starting' | 'running' | 'draining' | 'dead'

type UserContainerRecord = {
  key: string
  containerName: string
  containerId: string
  imageDigest: string
  configHash: string
  createdAt: number
  lastActiveAt: number
  activeSessionIds: Set<string>
  idleTimer: NodeJS.Timeout | null
  state: UserContainerState
  ensureLock: Promise<void> | null
  pendingRebuild: boolean
}
```

#### 进程边界（关键约束）

`UserContainerRegistry` **只活在主进程**。当前架构下 runner 是 `RuntimeService.spawnAttempt()` 拉起的独立子进程（`runtimeService.ts:1013-1039`，detached），与主进程**无共享内存**，仅通过 manifest 文件 + DB + attach socket 通信。因此：

```text
主进程职责 (RuntimeService):
  - 持有 UserContainerRegistry 实例
  - spawnAttempt 内调用 ensureUserContainer / acquireSession
  - 把 userContainerName + containerMode + per-session 路径写入 manifest
  - 订阅 runner child 'close' 事件触发 releaseSession (release 主路径)
  - heartbeat 超时 / reconcile / startup-reconcile 作为兜底 release 触发源

runner 子进程职责 (sessionRunnerDaemon + DockerBackend):
  - 从 manifest.session.runtime 读 userContainerName / containerMode
  - 只做 docker exec, 不调任何 registry 方法
  - 自然退出 (scode 结束 / destroy / crash) -> 主进程 close handler 处理 release
```

> 老路径 `containerMode='session'` 不受影响：runner 不需要 registry，DockerBackend 直接 `docker run --rm`。

#### Release 触发链（多级保险）

```text
主路径:   runner child 'close' 事件 -> 主进程触发 registry.releaseSession(orgId, userId, sid)
                                       (runner 正常退出 / destroy / crash 都会触发 close)

兜底 1:   heartbeat 超时 (现状已有, sessionRunnerDaemon.ts:92-95 每 heartbeatTimeoutMs/3 心跳)
          -> 主进程检测到心跳停 -> kill runner pid + release

兜底 2:   reconcileOnStartup (moss-server 重启时)
          -> 扫 DB sessions + docker ps + activeSessionIds 重建
          -> 处置矩阵见 §C3

兜底 3:   周期性 reconcile (可选, 后续增强)
          -> 每 N 分钟扫一次, 修正 registry.activeSessionIds 与 DB / 容器内 pidfile 的偏差
```

**不**引入 DB 事件 listener（项目现状没有可复用机制，新增成本大于收益）。DB 视为权威只读源，主路径 + 三级兜底足够。

#### Per-key mutex（取代 ensureLock）

`ensureLock` 是 Promise 单赋值，在 starting/draining/dead 三态转换并发场景下会出现 TOCTOU race（两个并发 ensure 看到 dead，各自 `registry.delete + new record`，起出两个容器）。改用真正的 per-key mutex，把所有状态机变更串行化：

```typescript
// 新文件 src/server/runtime/perKeyMutex.ts
class PerKeyMutex {
  #queues = new Map<string, Promise<unknown>>()
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(key) ?? Promise.resolve()
    const swallowed = prev.catch(() => {})
    const next = swallowed.then(fn)
    const tail = next.catch(() => {})
    this.#queues.set(key, tail)
    try { return await next } finally {
      // 仅在 queue 头还是自己时清掉, 防覆盖后续排队任务
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    }
  }
}
```

`ensureUserContainer / acquireSession / releaseSession / onIdleFire / touchRebuildHash` 都走 `mutex.run(key, ...)`。Record 上不再持有 `ensureLock` 字段。

#### ensure 流程（mutex 内串行）

```text
ensureUserContainer(orgId, userId):
  key = `${orgId}:${userId}`
  return mutex.run(key, async () => {
    let rec = registry.get(key)
    if (rec) {
      if (rec.state === 'running') {
        if (await dockerInspectAlive(rec.containerName)) return rec
        // 容器已被外部销毁
        rec.state = 'dead'; registry.delete(key); rec = undefined
      } else if (rec.state === 'draining') {
        // mutex 串行保证 draining 不会在 ensure 内出现 (上一次 onIdleFire 已经持锁完成 stop)
        // 走到这里说明状态机异常, 强制视为 dead 重建
        registry.delete(key); rec = undefined
      } else if (rec.state === 'dead') {
        registry.delete(key); rec = undefined
      }
      // state === 'starting' 在 mutex 下不可能 (上一次 ensure 已 await 完成)
    }
    if (!rec) {
      rec = newStartingRecord(key)
      registry.set(key, rec)
      try {
        await doCreate(rec)
        rec.state = 'running'
        return rec
      } catch (err) {
        rec.state = 'dead'
        registry.delete(key)
        throw err
      }
    }
    return rec
  })
```

> mutex 把 `starting/draining` 这两个中间态在 ensure 视角下抹掉——任何并发 ensure 都看到 stable 状态（`running` 或不存在）。

#### acquire / release

```text
acquireSession(orgId, userId, sessionId):
  key = `${orgId}:${userId}`
  return mutex.run(key, async () => {
    rec = registry.get(key); assert rec.state === 'running'
    rec.activeSessionIds.add(sessionId)
    if (rec.activeSessionIds.size === 1) {
      cancelUserContainerIdleTimer(rec)   // 触发点: acquire 0→1
    }
    rec.lastActiveAt = now()
  })

releaseSession(orgId, userId, sessionId):
  key = `${orgId}:${userId}`
  return mutex.run(key, async () => {
    rec = registry.get(key); if (!rec) return
    rec.activeSessionIds.delete(sessionId)
    if (rec.activeSessionIds.size === 0) {
      resetUserContainerIdleTimer(rec)    // 触发点: release 计数到 0
    }
  })
```

#### Idle timer 触发点

```text
resetUserContainerIdleTimer(rec) 在以下事件触发:
  1. releaseSession 后 activeSessionIds.size === 0 (最后一个 session 销毁)
  2. ensureUserContainer 完成、容器刚 running、activeSessionIds 仍为 0
     (兜底: 容器创建后无 session 进来时不悬挂; 极少触发, 但崩溃恢复路径下要写)

cancelUserContainerIdleTimer(rec) 在以下事件触发:
  1. acquireSession 后 activeSessionIds.size === 1 (从 0→1)
  2. registry 整体 shutdown
  3. 容器进入 'draining' / 'dead' 状态 (此时 reclaim 已在执行, timer 无意义)

重置而不是叠加: reset 时若已有 timer, 先 clear 再 set, 不要"延长"已有 timer.
```

#### reclaim 流程（mutex 内串行）

```text
resetUserContainerIdleTimer(rec):
  if (rec.idleTimer) clearTimeout(rec.idleTimer)
  rec.idleTimer = setTimeout(() => onIdleFire(rec.key), userContainerIdleTimeoutMs)
  rec.idleTimer.unref?.()

onIdleFire(key):
  return mutex.run(key, async () => {
    rec = registry.get(key); if (!rec) return
    if (rec.state !== 'running') return
    if (rec.activeSessionIds.size > 0) return    // 已被新 session 续命, double-check
    rec.state = 'draining'
    try {
      await dockerExec(['stop', '--time', String(stopTimeoutSec), rec.containerName])
      await dockerExec(['rm', rec.containerName]).catch(() => { /* 容器可能已被 stop 后移除 */ })
    } finally {
      rec.state = 'dead'
      registry.delete(key)
    }
  })
```

要点：

- 整个状态机变更都在 mutex 内，`draining` 状态对外不可见——任何并发 `ensure / acquire / release` 都在同一把锁后排队，看到的是 mutex 串行后的快照。
- `onIdleFire` 在 mutex 内 double-check `activeSessionIds.size === 0` 防止新 session 在 timer 到期与执行间隙 acquire 进来。
- `setTimeout(unref)` 不要阻塞 Node 退出；进程退出路径主动 `cancelUserContainerIdleTimer(*)` 兜底。

#### doCreate(rec)

```text
build container name = `moss-user-${hash12(orgId + ':' + userId)}`
build labels (moss.kind, moss.org, moss.user, moss.image, moss.image.digest, moss.runtime.config.hash)
build mounts (runtimeDir, MOSS_HOME)
build container-level env (见设计文档 §"环境变量分级")
spawn docker run -d --name ... --restart=no
  --pids-limit / --memory / --cpus / --ulimit
  --security-opt seccomp=unconfined --cap-add SYS_ADMIN
  --user $(uid):$(gid)
  -v / -e ...
  <image> sleep infinity
parse output 得 containerId
rec.containerId = ...
rec.containerName = ...
rec.imageDigest = ...
rec.configHash = ...
```

#### configHash 计算

```text
configHash = sha256(
  JSON.stringify({
    mossHome: MOSS_HOME,
    runtimeDir: <runtimeDir>,
    containerEnvKeys: [...sorted],
    resources: { pidsLimit, memory, cpus, nofile },
    launcherSha: sha256(launcher 脚本内容),
    reaperSha: sha256(reaper 脚本内容),
  })
)
```

如果 ensure 时发现现有 container 的 label `moss.runtime.config.hash` 与本次计算不一致：

- 该 user 当前无活跃 session → drain 并重建。
- 该 user 有活跃 session → `rec.pendingRebuild = true`，新 session 仍复用，等所有 session 结束再走 drain+重建路径。

#### 主进程 runner close handler 接入 release

`runtimeService.ts` 现有 `runnerPid` 跟踪（`runtimeService.ts:610-612`）。在拉起 runner 后注册 child close handler：

```text
// runtimeService.ts spawnAttempt 内, child spawn 之后
child.once('close', (code, signal) => {
  if (containerMode === 'user') {
    void this.userContainerRegistry.releaseSession(orgId, userId, sessionId)
      .catch(err => process.stderr.write(`[RuntimeService] release failed: ${err}\n`))
  }
  // 现有 close 处理沿用
})
```

要点：

- close handler 即便 release 抛错（如 registry 已 shutdown）也必须吃掉，不要阻塞 child 退出流程。
- 仅 `containerMode === 'user'` 时触发；session 模式不进这条路径。
- close handler 在 attempt 重建（新 generation）路径下也要正确处理——同一 session 短时间内多次 spawn 期间，release/acquire 必须由 mutex 串行（已由 PerKeyMutex 保证）。

#### 修改/新增文件清单

```text
src/server/runtime/perKeyMutex.ts                  新文件 (issue #5a)
src/server/runtime/userContainerRegistry.ts        新文件
src/server/runtimeService.ts                       集成 registry; spawnAttempt 前调 ensureUserContainer
                                                    + acquireSession; child 'close' handler 调 releaseSession;
                                                    reconcileOnStartup 调 registry.reconcile()
```

#### 验收

- 单测（mutex）：并发 100 次 ensure 同一 key 只产生一个 container；并发 acquire/release/ensure 混合无 race。
- 单测：state machine 转换 starting → running → draining → dead 不会卡死，draining 期间并发 ensure 等到 dead 后正确重建。
- 单测：`releaseSession` 后 `activeSessionIds.size === 0` 必然触发 `resetUserContainerIdleTimer`；`acquireSession` 后 `size === 1` 必然取消 timer。
- 单测：`onIdleFire` 在 timer 触发与执行间隙 `acquireSession` 进来时被 double-check 拦截，不 drain。
- 集测：手动 `docker rm` 容器后下次 `ensureUserContainer` 自动重建。
- 集测：kill -9 runner pid，主进程 child 'close' handler 触发 release，registry.activeSessionIds 正确递减；reconcile 路径不再做重复 release。
- 集测：moss-server 短时间内多次重启，registry 由 reconcileOnStartup 重建，不漏 / 不重复 activeSessionIds。

### C2. DockerBackend 分支

**目标**：`DockerBackend.spawn()` 根据 `runtime.containerMode` 走两条路径。

**老路径保留**：现有逻辑全部不动，作为 `containerMode === 'session'` 分支。

#### 主进程职责（在 runner 起来之前）

按 §C1 进程边界规定：

```text
RuntimeService.spawnAttempt(session, options):
  if containerMode === 'user':
    userContainer = await this.userContainerRegistry.ensureUserContainer(orgId, userId)
    await this.userContainerRegistry.acquireSession(orgId, userId, sessionId)
    manifest.session.runtime.userContainerName = userContainer.name
    manifest.session.runtime.containerMode = 'user'
    manifest.session.runtime.inContainerPidFile = `<runtimeDir>/sessions/<sid>/runtime/scode.pid`
    manifest.session.runtime.tmpDirInContainer  = `<runtimeDir>/sessions/<sid>/tmp`
    manifest.session.runtime.scodeHomeDir       = `<runtimeDir>/sessions/<sid>/scode-home/.nexus/sudocode`
  else:
    manifest.session.runtime.containerMode = 'session'
    (其他字段沿用老逻辑)

  child = await spawnSessionRunner(...)
  child.once('close', () => onRunnerClose(orgId, userId, sessionId, containerMode))
```

`onRunnerClose` 触发 §C1 描述的 `releaseSession`（仅 user 模式）。

#### runner 新路径（不再调 registry）

```text
async spawnInUserContainer(options):   // runner DockerBackend 内, 通过 options.runtime 拿信息
  resolve assistantConfig, mode (dockerMode), configDir (走老逻辑 buildConfigDir)
  resolve enabledSkills (走老逻辑)
  read manifest fields:
    userContainerName  = options.runtime.userContainerName    // 主进程已 ensure 好
    sessionRuntimeDir  = <runtimeDir>/sessions/<sid>/runtime  (mkdir)
    sessionTmpDir      = options.runtime.tmpDirInContainer    (mkdir)
    sessionScodeHome   = options.runtime.scodeHomeDir         (mkdir)
    safeCwd            = options.cwd === '/'
                          ? <runtimeDir>/sessions/<sid>/workspace
                          : options.cwd

  write per-session files (A1 已搬迁):
    sudocode.json -> sessionScodeHome
    settings.json -> sessionScodeHome
  syncWorkspaceSkills(safeCwd, enabledSkills, visibilityFilter)

  build docker exec args:
    -i
    -w safeCwd
    exec-level env:
      HOME=<configDir>
      SUDO_CODE_CONFIG_HOME=<sessionScodeHome>
      TMPDIR / TEMP / TMP = <sessionTmpDir>
      CLAUDE_CONFIG_DIR / CLAUDE_CODE_REMOTE_MEMORY_DIR = <configDir>
      MOSS_SESSION_ID, MOSS_ASSISTANT_NAME, MOSS_DEFAULT_MODEL, SESSION_TOKEN,
      SUDOWORK_AUTH_PROXY_TOKEN, ANTHROPIC_API_KEY/AUTH_TOKEN, PROXY_AUTH_TOKEN
    <userContainerName>
    moss-session-launch <sid> --
    /usr/local/bin/scode acp ...

  child = spawn('docker', args, { stdio: ['pipe','pipe','pipe'] })

  handle = createAcpBridgeHandle({
    child,
    containerMode: 'user',                 // 显式参数, 决定 destroy 行为分流
    sessionId: options.sessionId,
    cwd: safeCwd,
    transcriptPath: options.transcriptPath,
    runtime: {
      type: 'docker',
      containerMode: 'user',
      userContainerName,
      inContainerPidFile: `<runtimeDir>/sessions/<sid>/runtime/scode.pid`,
      tmpDirInContainer: sessionTmpDir,
      scodeHomeDir: sessionScodeHome,
      configDir,
      dockerMode: mode,
    },
    ...其他业务字段
  })

  // 重要: 不再调 registry.ensure/acquire/release
  // 重要: handle.destroy 由 DockerBackend 包一层 cleanupSessionArtifactsForUserContainer
  override handle.destroy to:
    await cleanupSessionArtifactsForUserContainer(handle, force)   // 见五步主路径
    // release 不在这里; 由主进程 child 'close' handler 触发

  return handle
```

#### AcpBridge 接口约定（按 containerMode 分流 destroy）

按拍板决策，`createAcpBridgeHandle` 显式收 `containerMode: 'session' | 'user'` 参数；AcpBridge 内部分两套 destroy 实现：

```text
createAcpBridgeHandle({
  child,
  containerMode,                  // 新增, 决定 destroy 路径
  sessionId, cwd, transcriptPath, runtime, ...其他
}): BackendHandle

handle.destroy(force) 行为:
  - containerMode === 'session' (老路径):
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
      host 模式下额外清理 configDir (现状 acpBridge.ts:798-802 保留)
  - containerMode === 'user' (新路径):
      handle.child.stdin?.end()         // 关 stdin, 不发信号
      // 不 kill child, 让 host docker exec CLI 进程随容器内 scode 退出自然结束
      // 真正的 scode kill 由 DockerBackend.cleanupSessionArtifactsForUserContainer 里调 reaper

handle.persistInProgressTurn(): Promise<void>
  - 在 maxDetachedBusyMs 兜底 kill 之前由调用方手动触发 (A2 已加)
  - 把 currentAssistantText / lastPersistedUuid 落 transcript
  - 写一条 'killed_by_idle_busy_timeout' 事件
```

#### 销毁语义在两种模式下的对照（实现者必看）

```text
containerMode = session (老):
  AcpBridge.destroy 给宿主机 docker run 子进程发信号
    → docker run 退出 → 容器随 --rm 自毁 → scode 死
  cleanupRuntimeArtifacts 里 docker rm -f 是兜底
  --> 信号路径是主要清理路径

containerMode = user (新):
  AcpBridge.destroy 仅关 stdin, 不发信号给 docker exec CLI
  必须由 moss-session-reap 在容器内主动 kill -PGID
  --> reaper 是真正的清理主路径; 不能调 docker rm -f 用户容器
  --> destroy(force=false) 也必须 reap, 不能依赖 stdin EOF / SIGPIPE 让 scode 自己退
```

#### force 参数语义重定义（新模式）

老模式 force=true 是 SIGKILL、false 是 SIGTERM。在新模式 reaper 才是真 kill，force 改为控制 reaper 的 grace + 是否 persist：

```text
handle.destroy(force=false):
  cleanup 内先 await persistInProgressTurn()
  reap grace = docker.execKillGraceMs   (默认 5000ms, TERM 等 grace 再 KILL)
handle.destroy(force=true):
  cleanup 内跳过 persistInProgressTurn
  reap grace = 0                         (立即 KILL, 不等)
```

#### cleanupSessionArtifactsForUserContainer —— 五步主路径

谁负责：DockerBackend 在 runner 进程内执行 step 1-4；step 5（registry release）由主进程 child 'close' handler 触发，**不**在这里调。

```text
Step 1.  if (!force) await handle.persistInProgressTurn()
         落 partial agent text + 'killed_by_idle_busy_timeout' 事件到 transcript
         force=true 路径跳过 (用户主动强杀, 不保留 partial)
         任何异常 -> 记 metric 'persist_failed', 继续 step 2

Step 2.  在容器内主动 kill scode (这是真正的 kill)
         graceMs = force ? 0 : docker.execKillGraceMs
         spawn 'docker exec <userContainerName> moss-session-reap <sid> <graceMs>'
         wait for completion 带 hard timeout = graceMs + 2000ms 保护
         reaper 内部已按 PGID + start_ticks 校验杀树
         reap 超时 -> metric 'reap_timeout', 继续 step 3 (不抛)
         reap exec 失败 (容器死/daemon 不通) -> metric 'reap_failed', 继续 step 3 (不抛)

Step 3.  关闭 / 等待 host 侧 docker exec CLI 子进程退出
         scode 进程组已死, 容器内 fd 关闭, host 侧 docker exec CLI 子进程会自然退出
         await waitForChildExit(handle.child, timeout = 3s)
         if (still alive after timeout):
           handle.child.stdin?.end()      // 已在 AcpBridge.destroy 里关过, 兜底再关
           handle.child.kill('SIGKILL')   // 仅清理 host fd, 不影响 scode (已死)
           metric 'host_exec_force_kill'

Step 4.  磁盘清理 (runner 进程内执行)
         await rmrf(`<runtimeDir>/sessions/${sid}/tmp`)
         await rmrf(`<runtimeDir>/sessions/${sid}/runtime`)     // 含 scode.pid / scode.start_ticks
         await rmrf(`<runtimeDir>/sessions/${sid}/scode-home`)  // A1 引入
         if (dockerMode === 'session'): await rmrf(configDir)
           // 注意: transcript 已迁出 configDir (A3), 此步不再删 transcript
         emit metric 'session_cleanup_done'

Step 5.  registry.releaseSession  ← 不在 runner 内调
         由主进程 onRunnerClose(orgId, userId, sid) 触发 (§C1)
         runner 进程退出后 child.once('close') 事件自然触达主进程
```

**NOT 做**：

- `docker rm -f` / `docker stop` 用户容器（registry 独占，runner 不碰）。
- reap 失败不升级清理（不 nuke 用户容器，孤儿走 reconcile）。
- runner 内**不**调 `registry.releaseSession`——runner 拿不到 registry 实例（进程边界），强行复制状态会与主进程视图不一致。

#### 修改文件清单

```text
src/server/backends/dockerBackend.ts        spawn 分流; cleanupSessionArtifactsForUserContainer
                                             (step 1-4); force → graceMs 映射
src/server/backends/acpBridge.ts            createAcpBridgeHandle 加 containerMode 参数;
                                             destroy 按模式分流; persistInProgressTurn 实现
src/server/runtimeService.ts                 spawnAttempt 内 ensure + acquire (主进程);
                                             child 'close' handler 调 releaseSession (主进程)
src/server/sessionManager.ts                 SessionRuntimeInfo 类型扩字段
                                             (containerMode/userContainerName/inContainerPidFile/
                                              tmpDirInContainer/scodeHomeDir)
```

#### 验收

- 集测：containerMode=user 启动一个 session，`docker exec` 出来的 scode 进程在容器内可见，host 侧 `docker exec` 子进程的 stdio 连通 ACP。
- 集测：reap 后 host 侧 `docker exec` 子进程退出，scode 进程组全部清掉，同容器其他 session 不受影响。
- 集测：**kill host 侧 `docker exec` 进程**模拟异常，容器内 scode **不应**自动退出（验证信号不转发的事实），后续 destroy 路径调 reaper 才真正清理。
- 集测：`handle.destroy(force=true)` 路径 graceMs=0，scode 立即 SIGKILL；`force=false` 路径 graceMs=execKillGraceMs，scode 收到 SIGTERM 后 grace 内退出。
- 集测：detached 长任务被 `maxDetachedBusyMs` kill 时，transcript 包含 partial agent text + `killed_by_idle_busy_timeout` 事件（验证 persistInProgressTurn 真生效）。
- 集测：reap exec 失败（mock docker daemon 不通）→ cleanup 仍完成磁盘清理，emit `reap_failed` 指标，**不**升级为 `docker rm -f` 用户容器。
- 集测：runner 进程正常退出后主进程 `child.once('close')` 触发 `releaseSession`；session 模式下不触发（验证 close handler 仅在 user 模式生效）。
- 集测：runner 被 `kill -9` 模拟异常退出，主进程 close handler 仍触发 release；activeSessionIds 递减正确。
- 集测：A3 transcript 迁出后，session destroy 后 `GET /sessions/:id/context` 仍能读到完整 transcript（**transcript 不在 configDir 内**，cleanup 不删）。

### C3. Reconcile 矩阵

**目标**：`reconcileOnStartup` 拉直"宿主机用户容器 × DB sessions × runner pid × 容器内 pidfile + start_ticks"四轴。

**位点**：`src/server/runtimeService.ts:583-594` 现有 `reconcileOnStartup()`。

#### 关键事实：reattach 仅在 runner 进程活时可用

代码依据 `sessionRunnerDaemon.ts:110-117`：runner 进程持有 unix socket `attachPath` 监听端。主进程 reattach 实际是连这个 socket，**前提是 runner 进程还在**。runner 死了 socket 就死了，**即便容器内 scode 还活着，stdio 也由已死 runner 持有，不能转交**。

所以处置矩阵必须区分 runner 死活：

```text
runner pid 活 (process.kill(runnerPid, 0) 成功):
  -> attachPath socket 可连 -> reattach (老路径, 仍可用)

runner pid 死:
  -> attachPath 已废
  -> 即便容器内 scode 活, stdio 也接不回来
  -> 必须 reap 孤儿 scode + resume from transcript (新 attempt, 新 runner, 新 docker exec)
```

#### 改造后的 reconcileOnStartup

```text
reconcileOnStartup():

  // 1. 重建用户容器视图 (在 PerKeyMutex 保护下批量操作)
  containers = docker ps --filter label=moss.kind=user-container --format '{{json .}}'
  for each container:
    parse moss.org / moss.user / moss.image.digest / moss.runtime.config.hash 标签
    key = `${org}:${user}`
    mutex.run(key, async () => {
      registry.set(key, {
        state: 'running',
        containerName, containerId,
        imageDigest, configHash,
        activeSessionIds: new Set(),    // 步骤 2 累加
        ...
      })
    })

  // 2. 跨表对账 (按 DB session 视角)
  dbSessions = listSessionsToRecover()
  for each ds in dbSessions:
    if ds.containerMode !== 'user':
      // session 模式或旧记录: 走现有 reattach-or-resume 逻辑, 不动
      continue

    runnerAlive = ds.runnerPid && safeKill0(ds.runnerPid)
    userContainer = registry.get(`${ds.orgId}:${ds.userId}`)

    if (!userContainer):
      // 容器不在 -> ensure 后 resume from transcript
      await ensureUserContainer(ds.orgId, ds.userId)
      await registry.acquireSession(ds.orgId, ds.userId, ds.id)
      await resumeFromTranscript(ds)
      continue

    probeResult = await probeContainerSession(userContainer, ds.id)

    switch true:
      case runnerAlive && probeResult.kind === 'alive':
        // 经典 reattach 路径
        await reattach(ds)
        await registry.acquireSession(ds.orgId, ds.userId, ds.id)

      case runnerAlive && probeResult.kind in ('dead', 'missing', 'stale_pid_reuse'):
        // runner 还活但 scode 已死 -> 让 runner 自然处理 / kill runner + resume
        await terminateRunner(ds.runnerPid)
        await reaper(userContainer, ds.id)         // 兜底, 即便 probe 说 dead 也再 reap 一次
        await resumeFromTranscript(ds)
        await registry.acquireSession(ds.orgId, ds.userId, ds.id)

      case !runnerAlive && probeResult.kind === 'alive':
        // 孤儿 scode: runner 死, scode 还在容器内跑, stdio 不可接管
        // 必须先 reap 后 resume (新 attempt 自带新 runner + 新 docker exec)
        metric 'reconcile_orphan_scode_total' +1
        await reaper(userContainer, ds.id)
        await cleanupTmpAndRuntime(ds)
        await resumeFromTranscript(ds)
        await registry.acquireSession(ds.orgId, ds.userId, ds.id)

      case !runnerAlive && probeResult.kind === 'stale_pid_reuse':
        // runner 死, pidfile PID 已被复用 -> 清元数据, resume
        metric 'reconcile_pid_reuse_total' +1
        await cleanupTmpAndRuntime(ds)
        await resumeFromTranscript(ds)
        await registry.acquireSession(ds.orgId, ds.userId, ds.id)

      case !runnerAlive && probeResult.kind in ('dead', 'missing'):
        // runner 死, scode 死, 干净 resume
        await cleanupTmpAndRuntime(ds)
        await resumeFromTranscript(ds)
        await registry.acquireSession(ds.orgId, ds.userId, ds.id)

  // 3. 孤儿 pidfile / tmp 清理 (容器内 session 不在 DB 视角)
  for each userContainer in registry:
    inContainerSids = await listContainerSessions(userContainer)   // 扫 /data/runtime/sessions/*/runtime/scode.pid
    for each sid in inContainerSids:
      if sid not in dbSessions:
        metric 'reconcile_orphan_pidfile_total' +1
        await reaper(userContainer, sid)
        await rm -rf <runtimeDir>/sessions/<sid>/{tmp,runtime,scode-home}
        // transcript 目录保留 (A3, 万一是 DB 丢了的 session 可以人工找回)

  // 4. 处理标记为重建的 orphan 容器
  for each container in registry:
    if (container.activeSessionIds.size === 0):
      if (container 不应存在: 无对应活用户 or hash 不一致):
        await mutex.run(key, async () => {
          rec.state = 'draining'
          await docker stop --time stopTimeoutSec rec.containerName
          await docker rm rec.containerName.catch(() => {})
          rec.state = 'dead'
          registry.delete(key)
        })
        metric 'reconcile_orphan_container_total' +1
```

#### probeContainerSession —— **必须** 校验 start_ticks

仅检查 `/proc/<pid>/stat` 可读会被 PID 复用骗——容器长生命周期下 PID 复用是必然事件。必须用与 reaper 同源的对账（`/proc/<pid>/stat` 第 22 字段 vs `runtime/scode.start_ticks`）。

```sh
docker exec <userContainerName> sh -c '
  SID="<sid>"
  RT_DIR="${MOSS_RUNTIME_DIR:-/data/runtime}"
  META="$RT_DIR/sessions/$SID/runtime"
  PIDFILE="$META/scode.pid"
  TICKSFILE="$META/scode.start_ticks"

  [ -f "$PIDFILE" ] || { echo missing; exit 0; }
  PID=$(cat "$PIDFILE")
  [ -r "/proc/$PID/stat" ] || { echo dead; exit 0; }
  [ -r "$TICKSFILE" ] || { echo dead; exit 0; }   # 无对账基准, 不可信任为活

  CUR=$(awk "{print \$22}" "/proc/$PID/stat")
  REC=$(cat "$TICKSFILE")
  if [ "$CUR" = "$REC" ]; then
    echo alive
  else
    echo stale_pid_reuse
  fi
'
```

probeResult.kind 枚举：

```text
'alive'             pidfile 存在 + PID 还在 + start_ticks 匹配
'dead'              pidfile 存在但 PID 不在 / start_ticks 文件缺失
'stale_pid_reuse'   pidfile 存在 + PID 还在 但 start_ticks 不匹配 (PID 已被复用)
'missing'           pidfile 不存在
```

处置：

```text
'alive':            按 runnerAlive 分支处置 (见上)
'dead':             清元数据 + resume
'stale_pid_reuse':  清元数据 + resume + metric +1
'missing':          清元数据 + resume
```

#### 修改文件清单

```text
src/server/runtimeService.ts                            reconcileOnStartup 扩展为四轴矩阵;
                                                         加 safeKill0 / terminateRunner helper
src/server/runtime/userContainerRegistry.ts             reconcile() 实现 (在 mutex 保护下批量)
src/server/runtime/probeContainerSession.ts             新文件, 带 start_ticks 校验
src/server/runtime/reaper.ts                            新文件, 包装 docker exec moss-session-reap
                                                         供 reconcile / cleanup 共用
```

#### 验收

- 集测（六轴组合，最小集）：
  - runner 活 + 容器在 + probe=alive → reattach
  - runner 活 + 容器在 + probe=dead → kill runner + reap + resume
  - runner 死 + 容器在 + probe=alive → **不**尝试 reattach；reap + resume；metric 计数 `reconcile_orphan_scode_total +1`
  - runner 死 + 容器在 + probe=stale_pid_reuse → 清元数据 + resume；metric `reconcile_pid_reuse_total +1`
  - runner 死 + 容器在 + probe=dead/missing → 清元数据 + resume
  - 容器不在 + DB 有 session → ensure + resume
- 集测：手工制造容器内 PID 复用场景（写 pidfile 指向已退出 PID，启新进程占同 PID），probe 返回 `stale_pid_reuse`，reconcile 走 resume 路径，不误杀新进程。
- 集测：reconcile 期间真实用户开新 session（mutex 保证不死锁、不重复 ensure）。
- 集测：reconcile 处理孤儿 pidfile（DB 无 session 但容器内 pidfile 存在）→ reap + 清盘 + metric `reconcile_orphan_pidfile_total +1`。
- 集测：reconcile 处理孤儿容器（hash 不一致 + activeSessionIds 空）→ drain + metric `reconcile_orphan_container_total +1`。

---

## D 阶段：灰度与回滚

### D1. Feature flag 灰度

- `docker.containerMode='session'` 是默认值；新模式靠配置开启。
- 灰度策略：
  1. 内部环境（dev）切 `user`，跑 1 周烟测。
  2. 选 1~3 个低风险 org 切 `user`（按配置覆盖，比如 `MOSS_DOCKER_CONTAINER_MODE_OVERRIDES=org-id-1:user,org-id-2:user`）。
  3. 默认切 `user`。
  4. 老模式保留至少 1 个发布版本，作为快速回滚路径。

**修改文件清单**：

```text
src/server/runtimeService.ts        读 per-org override
src/server/types.ts                 RuntimeConfigOverrides 字段
```

### D2. 监控

新增指标（暴露给 Prometheus 或现有日志管道）：

**Label 基数原则**：metrics label 数量 = label_value 笛卡尔积。每加一个高基数 label（user id、session id 等）都会显著放大存储和查询成本。**user 维度不进 metrics，进结构化日志**——运维按用户排查问题走日志聚合（ES / Loki），不走 Prometheus。

新指标：

```text
# Gauge: 全局
moss_user_container_count                         gauge              // 不分 label, 全局总数
moss_session_in_container_count                   gauge              // 不分 label, 全局总数

# Gauge: 受控基数 label
moss_user_container_count_by_state{state}         gauge              // starting/running/draining/dead
moss_user_container_count_by_org{org}             gauge              // org 通常 < 1k, 可控
moss_session_in_container_count_by_org{org}       gauge

# Histogram
moss_user_container_ensure_duration_seconds       histogram
moss_session_reap_duration_seconds                histogram
moss_acp_busy_duration_seconds                    histogram

# Counter
moss_user_container_reclaim_total{reason}         counter            // idle / hash_mismatch / shutdown
moss_user_container_rebuild_total{reason}         counter            // hash_mismatch / dead / corrupted
moss_session_reap_failed_total{reason}            counter            // grace_timeout / docker_error / pid_mismatch
moss_session_idle_busy_timeout_total              counter
moss_session_persist_in_progress_total{result}    counter            // ok / failed
moss_session_pid_reuse_skip_total                 counter
moss_reconcile_orphan_total{kind}                 counter            // container / scode / pidfile / tmp
moss_reconcile_pid_reuse_total                    counter
moss_host_exec_force_kill_total                   counter
moss_release_session_total{trigger}               counter            // child_close / heartbeat_timeout /
                                                                     //  reconcile / startup_reconcile
```

**禁止**的指标形态（高基数反模式）：

```text
{user}                  -> 用户数无上限, 会爆
{session_id}            -> 每个 session 一个 label_value
{transcript_session_id} -> 同上
{container_id}          -> 容器 id 随容器重建翻倍
```

至少要在控制台/日志能看到的关键事件（按 sessionId / userId 索引）：

- ensure / drain / rebuild 用户容器（含 org / user / containerName）
- session reap 超时/失败（含原因 + sessionId）
- pidfile starttime 校验拒绝 kill（含 pid + 期望/实际 start_ticks）
- maxDetachedBusyMs 兜底触发 + persistInProgressTurn 结果（含 sessionId）
- reconcile 处理的每条孤儿（含矩阵分支命中信息）
- release 触发源（child_close / heartbeat_timeout / reconcile）

### D3. 回滚

- 任何阶段发现致命问题 → 配置改回 `containerMode=session` → 现有 session 的 `containerMode='user'` 字段已经持久化，reconcile 时**老路径**遇到 `containerMode='user'` 也能处理（应当：drain 用户容器、resume from transcript）。
- 老路径 reconcile 必须能识别并处理 `containerMode='user'` 的旧 session 记录，不能假定全是 session 容器。这一条要在 C3 阶段内一起做。
- 留一个 `MOSS_FORCE_DRAIN_USER_CONTAINERS=true` 启动开关：moss-server 启动时立即 drain 所有 `moss-user-*` 容器（用于紧急回滚）。

### D4. 老模式下线（后续 release）

- 标记 `containerMode='session'` 为 deprecated。
- 1~2 个 release 后从代码删除老路径。

---

## 部署侧动作

不在代码里，但必须在 rollout 前完成。

0. **配置入口**：新增的运行策略字段都写入 `server.json` 的 `docker` 段。只要现有
   compose 已经包含以下能力，就不需要为了用户级容器修改 `docker-compose.yml`：
   - `/var/run/docker.sock` 已挂载给 moss-server。
   - `./server.json:/app/server.json:ro` 已挂载，且 `MOSS_SERVER_CONFIG=/app/server.json`。
   - `MOSS_AUTH_PROXY_HOST=0.0.0.0`，`MOSS_AUTH_PROXY_URL=http://moss-server:12013`。
   - moss-server 加入 `moss-network`，且 `server.json` 里 `docker.network` 也配置为同一个网络。
   - `MOSS_HOST_PATH_MAP` 的宿主机路径和容器内路径正确。
1. **`MOSS_HOST_PATH_MAP` 必须覆盖 `<runtimeDir>` 根**。设计文档 §"挂载路径"已说明。
   - 验证方式：在 moss-server 启动日志里加一行 `[DockerBackend] runtimeDir host path = <toHostPath(runtimeDir)>`，启动时立即可见。
   - 示例：
     ```text
     MOSS_HOST_PATH_MAP={
       "/data/moss-server/moss/data":"/app/data",
       "/data/moss-server/moss/.moss":"/root/.moss"
     }
     ```
   - 注意：这不是 `server.json` 字段，而是部署环境变量。它描述的是 moss-server 容器内路径到 Docker daemon 可识别宿主机路径的映射。
2. **镜像构建**：B3 的 launcher / reaper 脚本随镜像发布；`docker.image.digest` 校验依赖 image manifest，部署 pipeline 需要把镜像 digest 注入到 moss-server 启动配置。CI 必须包含 B3 §"镜像依赖约束" 列出的 6 项依赖检测，缺一立即 fail，不让坏镜像进 release。
3. **资源闸门默认值**：按真实硬件评估 `pidsLimit/memory/cpus`，文档给的是参考值。
4. **集群路由**：sticky routing 配置确保同 user 流量进同节点。如果是单节点部署可忽略。

---

## 修改文件总清单

按阶段汇总，便于 PR 拆分：

```text
A 阶段:
  src/server/backends/dockerBackend.ts       (A1: 写入路径 + SUDO_CODE_CONFIG_HOME)
  src/server/backends/backendUtils.ts        (A1: buildSessionScodeHomeDir)
  src/server/backends/acpBridge.ts           (A1: destroy 清 scode-home;
                                              A2: busy 状态机 + isBusy/onBusyChange
                                                  + persistInProgressTurn
                                                  + stopReason 路径接 reevaluateBusy)
  src/server/agentStore.ts                   (A1: agent override 加锁 + atomic rename)
  src/server/sessionManager.ts               (A2: SessionRecord 扩字段含 busy + reschedule;
                                              移除直接 destroy 路径, 改为通知 runner)
  src/server/sessionRunnerDaemon.ts          (A2: reschedule 算法 + onBusyChange 订阅)
  src/server/types.ts                        (A2: session.maxDetachedBusyMs)
  src/server/runtimePaths.ts                 (A3: getTranscriptPath 改签名,
                                                   迁出 configDir)
  src/server/runtimeService.ts               (A3: transcriptPath 新签名调用)
  src/server/sessionRunnerDaemon.ts          (A3: maybeUpdateTranscriptSession 新签名)
  src/server/transcript.ts                   (A3: 路径解析硬编码 (若有) 同步)
  src/server/budgetStats.ts                  (A3: transcriptPath 使用点扫一遍)
  src/server/dashboardStats.ts               (A3: 同上)
  scripts/migrate-transcript-paths.ts        (A3: 新增迁移脚本)
  src/server/__tests__/scode-config-home.test.ts             (A1)
  src/server/__tests__/busy-state.test.ts                    (A2, 5 类时序 + 集测)
  src/server/__tests__/assistant-override-concurrent.test.ts (A1)
  src/server/__tests__/transcript-path-migration.test.ts     (A3)

B 阶段:
  src/server/types.ts                    (配置项)
  src/server/db.ts                       (SessionRuntimeInfo schema)
  src/server/sessionManager.ts
  src/server/runtimeService.ts
  src/server/startStandaloneServer.ts
  deploy/runtime/Dockerfile              (镜像依赖检测 RUN command -v setsid ...)
  deploy/runtime/moss-session-launch.sh  (新)
  deploy/runtime/moss-session-reap.sh    (新)

C 阶段:
  src/server/runtime/perKeyMutex.ts                    (新, issue #5a)
  src/server/runtime/userContainerRegistry.ts          (新, 用 PerKeyMutex 串行化所有状态变更)
  src/server/runtime/probeContainerSession.ts          (新, 带 start_ticks 校验; issue #3)
  src/server/runtime/reaper.ts                         (新, 包装 docker exec moss-session-reap)
  src/server/runtimeService.ts                         (主进程 ensure/acquire/release;
                                                        child 'close' handler 调 release;
                                                        reconcile 四轴矩阵)
  src/server/backends/dockerBackend.ts                 (spawn 分流; 五步 cleanup; 不调 registry)
  src/server/backends/acpBridge.ts                     (createAcpBridgeHandle 加 containerMode;
                                                        destroy 按模式分流)
  src/server/sessionManager.ts                         (SessionRuntimeInfo 扩字段)
  src/server/__tests__/per-key-mutex.test.ts                       (C1)
  src/server/__tests__/user-container-registry.test.ts            (C1)
  src/server/__tests__/runner-close-release.test.ts               (C1, child close handler)
  src/server/__tests__/docker-backend-user-mode.test.ts           (C2, 五步 cleanup)
  src/server/__tests__/reconcile-four-axis.test.ts                (C3, 六轴组合最小集)

D 阶段:
  src/server/runtimeService.ts                         (per-org override 读取)
  src/server/types.ts                                  (override 配置)
  metrics 暴露 (按现有 metrics 管道集成; 按 D2 label 基数约束)
  文档化 deprecation 计划
```

---

## 拆 PR 建议

- **PR-A1**：per-session 配置文件搬迁 + 测试（可独立合并）
- **PR-A2**：busy 状态机 + idle 重设计 + 测试（可独立合并）
- **PR-A3**：transcript 路径迁出 configDir + 迁移脚本（**必须先于 A1 合并**，避免 A1 cleanup 把未迁移的 transcript 删掉）
- **PR-B1**：配置项 + DB schema 扩字段（不改运行时行为）
- **PR-B2**：launcher / reaper 脚本 + Dockerfile 改动（含镜像依赖检测）
- **PR-C1**：`PerKeyMutex` + `UserContainerRegistry` + 主进程集成（含单测）
- **PR-C2**：`DockerBackend` 分流 + 五步 cleanup + AcpBridge containerMode 参数
- **PR-C3**：reconcile 四轴矩阵 + probeContainerSession start_ticks 校验 + 老/新模式兼容
- **PR-D1**：灰度配置 + per-org override + 监控指标（按 D2 基数约束）

顺序约束：

- **PR-A3 必须先于 PR-A1**（transcript 迁出后 A1 才能安全删 configDir）。
- PR-A2、PR-B1 可与 A3 并行；PR-A1 等 A3 合后启动。
- PR-B2 由部署 / 镜像团队主导，可与 A 阶段并行。
- PR-C* 串行（C1 → C2 → C3）。
- PR-D1 在 C 全合并后。

---

## 风险登记

| 风险 | 缓解 |
|---|---|
| ~~scode 不支持 `--config` / `--mcp-config` CLI 参数~~ | **已消除**：scode 有 `SUDO_CODE_CONFIG_HOME` env（`runtime/src/config.rs::default_config_home()`），改 env 即可重定向 scode 的 config_home，无需改 scode |
| scode plugin/skill 路径解析对裸名称走 `config_home`，迁移后可能找不到 skill | A1 PR 内加 skill 发现集测；如需要，在 `${SUDO_CODE_CONFIG_HOME}/skills/` 下保留 symlink，或确认 scode 也支持从 workspace 发现 skill |
| docker exec 在某些 docker daemon 版本下信号转发不一致 | 不依赖信号转发，靠 reaper 主动杀；信号路径仅做 stdio 关闭；user 模式下 reaper 是真正主路径 |
| PID 复用窗口期 reap 误杀 | `/proc/<pid>/stat` 第 22 字段（clock ticks since boot）对账；launcher 与 reaper **必须**用同源单位（不能 `date +%s%N`，单位 / 参考点都不同）；校验失败时记 metric，跳过 kill |
| idle 计时误杀（任务跑完瞬间被 kill） | `idleTimeoutMs` 改为自 `(detached && !busy)` 同时成立起算；busy=true 期间只 arm `busyCeilingTimer`，busy→false 后重新 arm 完整 `idleTimeoutMs` |
| AskUserQuestion 期间用户离线，被兜底 kill 丢 partial output | `handle.persistInProgressTurn()` 在 `maxDetachedBusyMs` 触发 kill 前写下 `currentAssistantText` + `killed_by_idle_busy_timeout` 事件 |
| SessionManager 和 runner 双套 idle 计时器竞赛 | reschedule 算法统一一份；SessionManager 仅维护状态、不直接 destroy，destroy 触发集中到 runner |
| `MOSS_HOST_PATH_MAP` 部署未更新 | 启动日志显式打印挂载映射；ensure 失败立即报错 |
| 长生命周期容器内存泄漏堆积 | `--memory` 限制；监控容器 RSS；超阈值自动 drain |
| 同用户多 session 互相 `/proc/<pid>/environ` 读 token | 设计假设："同用户互信"；文档化威胁模型 |
| 镜像升级期间老容器还在跑 | `configHash` label 检测 + pendingRebuild 标记 |
| reconcile 与活跃流量竞争 | reconcile 内部走 ensure 锁；启动期短暂拒绝新 session（用 503）直到 reconcile 完 |
| **reattach 仅在 runner 进程活时可用**；runner 死 + scode 活的组合无法续接 stdio | reconcile 矩阵显式区分 `runnerAlive` 与 `probeResult.kind`；runner 死时一律 reap + resume，**不**尝试 reattach（§C3） |
| **probe 只看 `/proc/<pid>/stat` 可读会被 PID 复用骗** | probe 必须用与 reaper 同源的 `/proc/<pid>/stat` 第 22 字段对 `scode.start_ticks`；不匹配返回 `stale_pid_reuse` 走 resume；metric `reconcile_pid_reuse_total` 暴露给监控（§C3） |
| **transcript 历史数据迁移失败** | A3 迁移脚本保守：cp + verify + 改 DB + rm，任一步失败回滚；失败 session 保留老 transcript_path + metric `transcript_migrate_failed_total`；迁移异步触发不阻塞 moss-server 启动；支持断点续传 |
| **基础镜像切换导致 launcher / reaper 依赖丢失** | B3 §"镜像依赖约束" 显式列出 6 项依赖；Dockerfile RUN 内校验；CI 必须在镜像构建后跑独立依赖检测，缺一 fail，不让坏镜像进 release |
| **registry 跨进程错误（runner 调主进程 registry）** | runner 不持有 registry 引用；所有 ensure/acquire/release 在主进程；runner 自然退出后由主进程 child 'close' handler 触发 release；§C1 进程边界小节 |
| **UserContainerRegistry 状态机 race** | 用 PerKeyMutex 取代单 Promise ensureLock；所有 ensure/acquire/release/onIdleFire 串行；§C1 mutex 小节 |
| **idle timer 起算点错（acquireSession 1→0）** | 触发点修正为 `releaseSession` 后 `activeSessionIds.size === 0`；`acquireSession` 后 `size === 1` 取消 timer（§C1） |
| 高基数 metrics label（user / session id 等）拖死 Prometheus | D2 §"Label 基数原则"：user 维度只进日志不进 metrics；指标按 state / org 受控基数 label 暴露 |
| AcpBridge user 模式 destroy 误发信号杀 child | createAcpBridgeHandle 显式收 `containerMode` 参数；user 模式 destroy 仅关 stdin、**不** kill child；真正 kill 由 DockerBackend 调 reaper 完成（§C2） |

---

## 工时粗估（参考）

- A1：3-5 天（含 skill 发现路径验证）
- A2：5-7 天（状态机 + reschedule 算法 + 5 类 regression 单测 + 集测；含 persistInProgressTurn 和 SessionManager↔runner 协同）
- A3：3-5 天（getTranscriptPath 改签名 + 迁移脚本 + 断点续传 + 验收；**必须先于 A1 合并**）
- B1：1 天
- B2：1-2 天（含迁移脚本）
- B3：2-3 天（脚本 + 镜像依赖检测 + CI 集成 + PID 复用对账测试）
- C1：6-8 天（PerKeyMutex + registry + 主进程 close handler 接入 + 多场景单测）
- C2：4-5 天（spawnInUserContainer + 五步 cleanup + AcpBridge containerMode 分流 + persist 钩子接入）
- C3：5-7 天（四轴 reconcile + probe start_ticks 校验 + 六轴最小集集测）
- D1：2-3 天（灰度配置 + 监控）

合计 ~31-46 工程日，按 1-2 人并行约 4-5 周可发布到内部环境，再 1-2 周灰度到生产。
