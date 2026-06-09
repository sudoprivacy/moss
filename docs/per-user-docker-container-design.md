# 用户级 Docker 容器设计

## 目标

当前 Docker runtime 是每个 session attempt 启一个容器。目标模式只调整容器边界：

- 一个用户对应一个长生命周期 Docker 容器。
- 每个会话仍然对应一个独立 `scode acp` 进程，通过 `docker exec` 启动。
- 每个会话仍然有独立 workspace、configDir、transcript、runner 和 attach socket。

这样可以减少重复 `docker run` 的冷启动成本，同时不改变客户端现有会话 API 和文件预览模型。

非目标：

- 不把多个会话合并到同一个 `scode` 进程里。
- 不让 `containerMode=user` 改变跨会话记忆共享的语义。
- 不引入 `--privileged` 之类的新能力，安全模型沿用现状。

## 当前 Docker 模式

当前每个 session attempt 直接启动一个容器：

```text
docker run --rm -i --name moss-session-<sessionId12>-g<generation> \
  -v <session config>:<session config> \
  -v <session workspace>:<session workspace> \
  -v <MOSS_HOME host>:<MOSS_HOME container> \
  -w <session workspace> \
  <image> /usr/local/bin/scode acp ...
```

实际挂载主要有 3 类：

```text
<runtimeDir>/sessions/<sessionId>/workspace
  -> 容器内同一逻辑 workspace 路径

<runtimeDir>/sessions/<sessionId>/config
  -> 容器内同一逻辑 config 路径

<MOSS_HOME>
  -> 容器内 MOSS_HOME，通常是 /root/.moss
```

作用分别是：

- `workspace`：当前会话的工作目录。`scode` 在这里读写文件，生成文件会落到宿主机，所以现有文件树和文件预览接口可以直接读取。
- `config`：当前会话的 HOME 和 scode 配置目录。里面会放生成的 `sudocode.json`、MCP `settings.json`、assistant override 文件，以及其他会话级状态。
- `MOSS_HOME`：MOSS 已安装的智能体、技能和本地资源目录。workspace/config 中创建的技能软链会指向这里，因此容器内必须能访问。

在容器化部署 moss-server 时，moss-server 看到的路径和 Docker daemon 需要的宿主机路径可能不同。当前通过 `MOSS_HOST_PATH_MAP` 把 `/app/data/runtime/...` 这类容器内路径映射回 `/data/moss-server/moss/data/runtime/...` 这类宿主机路径。

清理边界：每个 session 销毁时，容器随 `docker run --rm` 退出，`DockerBackend.cleanupRuntimeArtifacts()` 再做一次 `docker rm -f` 兜底。session 模式下还会 `rm -rf configDir`。

## 目标模式

用户容器首次创建后保持运行：

```text
docker run -d --name moss-user-<hash(orgId:userId)> \
  --restart=no \
  --pids-limit <docker.user.pidsLimit> \
  --memory <docker.user.memory> \
  --cpus <docker.user.cpus> \
  --ulimit nofile=<docker.user.nofile> \
  --security-opt seccomp=unconfined \
  --cap-add SYS_ADMIN \
  --label moss.kind=user-container \
  --label moss.org=<orgId> \
  --label moss.user=<userId> \
  --label moss.image=<image> \
  --label moss.image.digest=<sha256> \
  --label moss.runtime.config.hash=<configHash> \
  -e MOSS_SESSION_USER_ID=<userId> \
  -e MOSS_SESSION_ORG_ID=<orgId> \
  -e MOSS_SESSION_ROLE=<role> \
  -e MOSS_SESSION_SCOPES=<scopes> \
  -e MOSS_SERVER_URL=<...> \
  -e SUDOWORK_AUTH_PROXY_URL=<...> \
  -e SUDOWORK_AUTH_PROXY_BASE_URL=<...> \
  -e ANTHROPIC_BASE_URL=<...> \
  -e MOSS_HOME=<MOSS_HOME container> \
  -v <runtimeDir host>:<runtimeDir container> \
  -v <MOSS_HOME host>:<MOSS_HOME container> \
  <image> sleep infinity
```

每个会话启动时，在该用户容器里单独启动一个 `scode` 进程：

```text
docker exec -i \
  -w <runtimeDir>/sessions/<sessionId>/workspace \
  -e HOME=<runtimeDir>/sessions/<sessionId>/config \
  -e TMPDIR=<runtimeDir>/sessions/<sessionId>/tmp \
  -e TMP=<runtimeDir>/sessions/<sessionId>/tmp \
  -e TEMP=<runtimeDir>/sessions/<sessionId>/tmp \
  -e CLAUDE_CONFIG_DIR=<runtimeDir>/sessions/<sessionId>/config \
  -e CLAUDE_CODE_REMOTE_MEMORY_DIR=<runtimeDir>/sessions/<sessionId>/config \
  -e MOSS_HOME=<MOSS_HOME container> \
  -e MOSS_SESSION_ID=<sessionId> \
  -e MOSS_ASSISTANT_NAME=<...> \
  -e MOSS_DEFAULT_MODEL=<...> \
  -e SESSION_TOKEN=<...> \
  -e SUDOWORK_AUTH_PROXY_TOKEN=<...> \
  -e ANTHROPIC_API_KEY=<...> \
  -e ANTHROPIC_AUTH_TOKEN=<...> \
  -e PROXY_AUTH_TOKEN=<...> \
  moss-user-<hash(orgId:userId)> \
  /usr/local/bin/moss-session-launch <sessionId> -- \
    /usr/local/bin/scode acp ...
```

隔离边界变为：

```text
容器：用户级
runner 进程：session attempt 级
scode 进程：session attempt 级
workspace：session 级
configDir：默认 session 级
TMPDIR：session 级
transcript：session 级
```

同一个用户容器中可以同时有多个 `scode` 进程，但这些进程使用不同的工作目录、配置目录和临时目录。

## 环境变量分级：容器级 vs exec 级

`docker run` 阶段写入的 env 在容器生命周期内对所有 exec 共享；`docker exec` 阶段写入的 env 仅对该次 exec 进程生效。混用会导致 token 串台、模型/智能体读错。

**容器级（`docker run -e`）**：在同一用户内对所有 session 都恒定的值。

```text
MOSS_SESSION_USER_ID
MOSS_SESSION_ORG_ID
MOSS_SESSION_ROLE
MOSS_SESSION_SCOPES
MOSS_SERVER_URL
MOSS_HOME
SUDOWORK_AUTH_PROXY_URL
SUDOWORK_AUTH_PROXY_BASE_URL
ANTHROPIC_BASE_URL
```

**exec 级（`docker exec -e`）**：每个 session attempt 各自不同的值。**绝不能**写到容器级，否则不同 attempt 拿到同一份。

```text
MOSS_SESSION_ID
MOSS_ASSISTANT_NAME
MOSS_DEFAULT_MODEL
SESSION_TOKEN
SUDOWORK_AUTH_PROXY_TOKEN
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
PROXY_AUTH_TOKEN
HOME
CLAUDE_CONFIG_DIR
CLAUDE_CODE_REMOTE_MEMORY_DIR
SUDO_CODE_CONFIG_HOME      # 解耦 scode 配置路径与 HOME, 见"共享 configDir 下的写并发处理"
TMPDIR / TEMP / TMP
```

实现上对应把现有 `passthroughEnvKeys` 拆成两组常量数组，在 `RuntimeService.ensureUserContainer()` 和 `DockerBackend.spawnInUserContainer()` 分别消费。

## 多进程隔离与并发上限

用户级容器不是把同一用户的所有会话合并成一个 `scode`。推荐模型仍然是：

```text
一个用户容器
  -> 多个 session runner
    -> 多个 docker exec
      -> 多个 scode acp 进程
```

这在技术上可行，因为 `scode acp` 本身是前台进程，stdin/stdout/stderr 由各自 runner 管理；只要每个 `docker exec` 的 cwd、HOME/config 和临时目录不同，不同会话的文件状态仍然隔离。

每个 `docker exec` 必须增加 session 级 `TMPDIR`：

```text
TMPDIR=<runtimeDir>/sessions/<sessionId>/tmp
TEMP=<runtimeDir>/sessions/<sessionId>/tmp
TMP=<runtimeDir>/sessions/<sessionId>/tmp
```

启动前由 moss-server 或 runner 创建目录：

```text
<runtimeDir>/sessions/<sessionId>/tmp
```

原因：

- 避免多个 `scode` 进程在用户容器内共享 `/tmp`，导致固定临时文件名、socket 文件、缓存文件互相覆盖。代码里已有 `CLAUDE_CODE_TMPDIR`（`imagePaste.ts`）、tmux socket（`tmuxSocket.ts`）、bash provider tmp（`bashProvider.ts`）都直接读 `TMPDIR`。
- session 结束后可以按 session 清理 tmp，不影响同一用户其他会话。
- 后续如果某些工具依赖临时目录中的中间产物，文件仍然落在宿主机可见的 runtime 目录下，便于排查。

并发上限分两层。

**全局上限**：保留现有 `SessionManager.#maxSessions`（默认 32），保护宿主机。

**每用户上限**：新增

```text
docker.maxSessionsPerUser = 5
```

校验位置应在 `RuntimeService.spawnAttempt()` 或更靠近创建 attempt 的主进程路径中执行，而不是只放在 runner 里。判断口径建议是同一 `orgId/userId` 下仍处于 `creating`、`active`、`detached` 的 session/attempt 数量。超过上限时，新建会话或拉起 attempt 应直接返回明确错误，例如 `user_runtime_concurrency_limit_exceeded`。

## 资源闸门与安全模型

长生命周期容器把单容器爆炸半径放大，必须设置资源闸门。一次性容器靠 `--rm` 兜底的隐性"自愈"在新模式下失效。

推荐默认（可配置）：

```text
docker.user.pidsLimit = 512        // 防 fork 风暴
docker.user.memory    = 4g         // 单用户内存上限
docker.user.cpus      = 2          // 单用户 CPU 配额
docker.user.nofile    = 4096       // 文件描述符上限
```

安全模型沿用现状但需明确威胁假设：

- 容器内仍然 `--security-opt seccomp=unconfined --cap-add SYS_ADMIN --permission-mode danger-full-access`。
- `--user $(uid):$(gid)` 仍是 moss-server 主进程的 UID，**同用户所有 session 在容器内共用同一 Linux UID**，文件系统层面没有 session 间隔离。
- 由此推出的互信假设：**用户容器内 session 互信 = 等同于同一 Linux 用户互信**。这不是一次性容器模式新引入的，但新模式下更明显，文档级别需要明确写入。
- `--restart=no`：异常崩溃后由 moss-server 决策（走 reconcile），不要让 Docker 自动重生半破容器。
- 不引入 `--privileged`、不暴露 docker socket、不增加 `--cap-add` 新项。

## 挂载路径

用户级容器不能只挂载第一个会话的 workspace/config。Docker 不能给已经运行的容器动态追加 bind mount，否则后续新会话目录在容器内不可见。

因此用户级容器应该挂载稳定父目录：

```text
<runtimeDir> -> <runtimeDir>
<MOSS_HOME>  -> <MOSS_HOME container path>
```

这样同一用户后续所有会话目录都天然可见：

```text
<runtimeDir>/sessions/<sessionA>/workspace
<runtimeDir>/sessions/<sessionA>/config
<runtimeDir>/sessions/<sessionA>/transcript    // A3 引入: 独立目录, 不在 configDir 下
<runtimeDir>/sessions/<sessionA>/runtime       // pidfile / start_ticks
<runtimeDir>/sessions/<sessionA>/scode-home    // A1 引入: SUDO_CODE_CONFIG_HOME
<runtimeDir>/sessions/<sessionA>/tmp
<runtimeDir>/sessions/<sessionB>/...
<runtimeDir>/users/<userId>/config             // memory_mode=user 用
```

也就是说，容器是用户级复用，但每个会话仍然是自己的目录：

```text
moss-user-<userHash>
  session A:
    cwd        = <runtimeDir>/sessions/sessionA/workspace
    config     = <runtimeDir>/sessions/sessionA/config
    transcript = <runtimeDir>/sessions/sessionA/transcript/<tsid>.jsonl  // A3: 与 config 分离
    runtime    = <runtimeDir>/sessions/sessionA/runtime
    scode-home = <runtimeDir>/sessions/sessionA/scode-home/.nexus/sudocode
    tmp        = <runtimeDir>/sessions/sessionA/tmp

  session B: 同上结构
```

### Transcript 与 configDir 解耦（A3 决策）

历史上 transcript 落在 `<configDir>/projects/<sanitized-cwd>/<tsid>.jsonl`（`runtimePaths.ts:81-87`），与 scode 运行时配置混在一起。问题：

- `dockerBackend.ts:316-335` 老路径 cleanup 在 session 模式 `rm -rf configDir` —— **transcript 跟着删**。
- `GET /api/v1/sessions/:id/context`（`transcript.ts:100, 135`）依赖 `session.transcriptPath` 文件存在；session destroy 后 UI 显示"历史会话"读不到 transcript。
- 这是 pre-existing 行为，不是新方案引入；但新方案 cleanup 仍要清 configDir，问题不会自动消失。

新方案（A3 决策为 B）：把 transcript 迁出 configDir，放到独立目录：

```text
旧路径: <configDir>/projects/<sanitized-cwd>/<tsid>.jsonl
新路径: <runtimeDir>/sessions/<sid>/transcript/<tsid>.jsonl
```

`getTranscriptPath` 改签名收 `runtimeDir + sessionId + tsid`，`cwd` 不再参与（sessionId 已经唯一隔离）。所有 cleanup 路径**不删** transcript 目录——`runtimeDir/sessions/<sid>/transcript/` 在 session destroy 后保留，符合"历史会话仍可查阅"的用户预期。

历史 session 通过一次性迁移脚本搬到新路径（实现方案 §A3 描述），迁移失败的保留老路径 + metric，分批处理不阻塞 moss-server 启动。

`safeCwd` 兜底逻辑同步调整：原代码在 `cwd === '/'` 时回退到 `os.homedir()`（moss-server 主机 home），共享容器内未必挂载。新模式下回退路径必须是已挂载的 `<runtimeDir>/sessions/<sessionId>/workspace`，并在容器外提前 mkdir。`/` 兜底要么删除、要么改为该路径。

### MOSS_HOST_PATH_MAP 必须覆盖 runtimeDir 根级

`dockerBackend.ts` 的 `toHostPath()` 使用最长前缀匹配。

之前每个 session 一个容器时，往往只挂 `<runtimeDir>/sessions/<sid>/...`，`MOSS_HOST_PATH_MAP` 可以只配 session 级别。**切到用户容器后挂载的是 `<runtimeDir>` 根**，如果 `MOSS_HOST_PATH_MAP` 没有覆盖到这个父路径，最长前缀匹配会失败，容器看到的是它本地路径自己映射自己，挂载点错位。

部署时必须确保：

```text
MOSS_HOST_PATH_MAP = {
  "<runtimeDir host>": "<runtimeDir container>",
  "<MOSS_HOME host>":  "<MOSS_HOME container>"
}
```

而不是只配 `sessions/<sid>` 这种粒度。

### 部署配置入口

用户级容器的运行策略配置写在 `server.json` 的 `docker` 段。部署时如果
moss-server 已经通过 `MOSS_SERVER_CONFIG=/app/server.json` 读取挂载进去的
`server.json`，则开启新模式不需要为了这些新增字段修改 `docker-compose.yml`。

推荐配置：

```json
{
  "docker": {
    "network": "moss-network",
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

字段含义：

- `containerMode=session`：旧逻辑，每个 session 一个 `docker run --rm` 容器。
- `containerMode=user`：新逻辑，每个 `(orgId, userId)` 一个长生命周期容器，每个 session 一个 `docker exec scode` 进程。
- `network`：用户容器要加入的 Docker 网络。容器化部署下若 auth proxy URL 是 `http://moss-server:12013`，必须和 compose 网络一致，例如 `moss-network`。
- `maxSessionsPerUser`：同一用户容器内并发 session / `scode` 进程上限。
- `userContainerIdleTimeoutMs`：该用户没有任何 active session 后多久销毁用户容器，单位毫秒。
- `execKillGraceMs`：终止单个 session `scode` 进程组时 TERM 到 KILL 的等待时间，单位毫秒。
- `user.*`：用户级容器资源闸门。

`MOSS_HOST_PATH_MAP`、`MOSS_AUTH_PROXY_URL`、`MOSS_AUTH_PROXY_HOST` 仍然是部署环境变量，不属于 `server.json`。如果现有 compose 已经正确配置这些变量、挂载 docker sock、挂载 `server.json` 并加入 `moss-network`，则本需求只需要改 `server.json` 开关和参数。

这样不会影响现有客户端逻辑：

- `GET /api/v1/sessions/:id` 仍然读取 DB 中的 session 元数据。
- `GET /api/v1/sessions/:id/context` 仍然读取该 session 的 transcript。
- `GET /api/v1/sessions/:id/workspace/tree` 仍然读取宿主机上的 session workspace。
- `GET /api/v1/sessions/:id/workspace/file` 仍然预览宿主机上的 session workspace 文件。
- `/ws/sessions/:id` 仍然 attach 到该 session 当前 attempt。

## ConfigDir 策略

不要因为容器是用户级，就强制所有会话共享同一个用户级 configDir。

第一版建议：

```text
docker.containerMode = user
dockerMode = session
```

含义是：

- 容器按用户复用。
- 每个 session 仍然保留自己的 configDir。
- 并发会话不会互相覆盖 `settings.json`、`sudocode.json`、assistant override 文件或 MCP 配置。

如果某个 assistant 明确需要跨会话记忆，继续使用现有 `memory_mode=user` / `dockerMode=user` 机制。容器复用和记忆共享应当是两个独立概念。

## 共享 configDir 下的写并发处理

这是新模式下被放大的真问题，必须在第一版就解决，而不是只列为"已知风险"。

**问题面**：`DockerBackend.spawn()` 在 spawn 入口无条件 `writeFileSync(<configDir>/.nexus/sudocode/sudocode.json)` 和 `writeFileSync(<configDir>/.nexus/sudocode/settings.json)`，并调用 `createSkillSymlinks(configDir, enabledSkills)` 在 configDir 下增删 skill 软链。

```text
dockerMode = session   sessions/<sid>/config/.nexus/sudocode/...     各自独立, 无冲突
dockerMode = user      users/<uid>/config/.nexus/sudocode/...        共享, 并发覆盖
```

之前一次性容器模式下 user-mode 同用户并发并不常见，问题被时间稀释。改为用户级容器后，**同用户并发是常态**，后写赢的覆盖会让 sudocode.json、settings.json、skill 软链频繁错乱。

第一版要做的事：

1. **per-session 文件放到 per-session 目录，不要塞进共享 configDir**。利用 scode 既有的 `SUDO_CODE_CONFIG_HOME` env（`runtime/src/config.rs::default_config_home()` 优先读它），把 scode 的 `config_home` 从 `$HOME/.nexus/sudocode`（即共享 configDir）拉到 per-session 路径：
   - per-exec 设 `SUDO_CODE_CONFIG_HOME=<runtimeDir>/sessions/<sid>/scode-home/.nexus/sudocode`。
   - `sudocode.json` 写到 `${SUDO_CODE_CONFIG_HOME}/sudocode.json`。
   - `settings.json` 写到 `${SUDO_CODE_CONFIG_HOME}/settings.json`。
   - `HOME=<configDir>` **保持不变**——assistant override 和 shared memory 仍走 HOME / `CLAUDE_CODE_REMOTE_MEMORY_DIR` 路径，与 scode 配置完全解耦。
   - 不需要修改 scode 源码、不需要新增 CLI flag。

2. **skill symlinks 改走 workspace，不走 configDir**。
   - 现有 `syncWorkspaceSkills(safeCwd, enabledSkills)` 已经在 `<workspace>/.nexus/sudocode/skills/` 下建链，**workspace 是 per-session 的**。
   - 删除 / 关掉 `createSkillSymlinks(configDir, enabledSkills)` 这一份在 configDir 下的副本，避免双写。
   - 验证 scode 启动时是否优先读 workspace 下的 skill 目录；如果不读，调整 skill 搜索顺序或环境变量。

3. **assistant override 文件**（`memory_mode=user` 下的 `_moss_meta.json` 派生文件）继续允许写 user-mode configDir，但要：
   - 写入前先用 advisory lock（`flock` / 文件锁）；
   - 写入用 `tempfile + rename` 原子替换，避免半写文件被并发读到。

4. **shared memory（`MEMORY.md`）的并发追加**沿用现有 lock 即可，文档级 review 但不重做。

落地后 user-mode 共享 configDir 下还剩什么：assistant override、MCP user-level 配置、shared memory。这些都是"按用户语义共享"的内容，不再有 per-session 文件混在里面。

## 跨会话共享智能体

用户级容器方案需要明确区分两个概念：

```text
containerMode = user  // 容器按用户复用
dockerMode = user     // configDir 和记忆按用户共享
```

`containerMode=user` 不应该自动推导出 `dockerMode=user`。它只表示同一用户的新会话和后续会话进程会通过 `docker exec` 进入同一个用户容器。

现有跨会话共享智能体逻辑依赖的是 `memory_mode=user`：

```text
assistant _moss_meta.json: memory_mode = user
  -> RuntimeService 将 dockerMode 解析为 user
  -> configDir = <runtimeDir>/users/<userId>/config
  -> shared memory = <runtimeDir>/users/<userId>/config/.moss/memory/<assistantName>/MEMORY.md
```

因此，在用户级容器模式下应保留现有解析规则：

```text
普通智能体:
  containerMode = user
  dockerMode = session
  configDir = <runtimeDir>/sessions/<sessionId>/config

跨会话共享智能体:
  containerMode = user
  dockerMode = user
  configDir = <runtimeDir>/users/<userId>/config
```

只要用户容器挂载了稳定父目录：

```text
<runtimeDir> -> <runtimeDir>
```

跨会话共享智能体的用户级 configDir 和记忆文件就仍然在容器内可见：

```text
<runtimeDir>/users/<userId>/config
<runtimeDir>/users/<userId>/config/.moss/memory/<assistantName>/MEMORY.md
```

所以用户选择 `memory_mode=user` 的智能体时，跨会话共享逻辑不会因为容器复用而失效。会话启动时仍然会读取 shared memory，写入 assistant override，并在首条消息中注入共享记忆。

并发安全由"共享 configDir 下的写并发处理"一节负责。`dockerMode=user` 共享 configDir 仅存放真正"用户级语义"的文件，per-session 文件已经搬走。

实现原则：

```text
containerMode 只控制容器复用。
dockerMode / hostMode 继续控制 configDir 和跨会话记忆共享。
```

## Busy 状态机与事件源

新模式下"不活跃 session"的定义必须从"没有客户端连接"升级为"没有客户端连接 **且** 没有任务在跑"，否则 idle 回收会在用户离开页面、长任务还在跑时误杀 scode。

更关键的一点：`idleTimeoutMs` **必须**自"(detached && !busy) 同时成立"那一刻起算，**不能**从客户端断开瞬间起算。否则会出现下面这个真实事故面：

```text
T0          客户端 attach, 长任务开跑, busy = true
T0+9min     客户端断开, busy 仍 true
T0+19min    距离断开 10min = idleTimeoutMs, busy 仍 true → 不杀, 正确
T0+19min+1s 任务完成, busy = false 翻转
            若用 "detachedFor >= idleTimeoutMs" 判定:
              clients=0 && !busy && detachedFor=10min → 立即 destroy
              用户刚回来还没刷新页面, 任务结果已被 kill
```

因此判定必须改为 "**只在 (detached && !busy) 同时成立时才 arm idleTimeoutMs 计时器**，任一条件翻转就取消/重置"。

### Busy 状态来源

`busy = true` 触发（任一成立即 true）：

- `AcpBridge.writeStdin()` 入口被调用——无论走 `processUserMessage` 还是 `pendingStdin` buffer 分支都算。
- `pendingAskUserQuestions` 非空（scode 抛出 AskUserQuestion，正在等用户回答）。

`busy = false` 触发（同时满足）：

- AcpBridge 收到带 `parsed.result?.stopReason` 的 ACP 消息（参考 `acpBridge.ts:431` 现有判定路径），这是 scode 通告 turn 结束的权威信号。
- 且 `pendingAskUserQuestions` 为空。
- 且 `pendingStdin` buffer 为空。

scode 退出：`busy = false`（给上游一个干净的最终状态）。

**不能**作为 busy 判定依据的几个 Map（很容易踩）：

- `toolResultIdByToolCallId`：是 id 映射表，**只增不删**。
- `currentTurnToolCalls`：只在 stopReason 时整体 `clear()`（见 `acpBridge.ts:456`），turn 中 size > 0 不代表"还有 tool 在跑"。
- `pendingRpcRequests`：是 moss→scode 的短命 RPC（如 `m-set-model`），跟 turn 状态无关。

scode 已在 stopReason 一并 flush turn 内全部 tool calls（`acpBridge.ts:437-456`），**stopReason 就是"本 turn 全部已落地"的唯一信号**。不需要单独跟踪 pending tool。

### Busy 状态向上传递

把 busy 提升到 `BackendHandle` 抽象层，让 runner / SessionManager 都能订阅：

```text
BackendHandle 新增:
  isBusy(): boolean
  onBusyChange(listener: (busy: boolean) => void): () => void
  persistInProgressTurn(): Promise<void>   // maxDetachedBusyMs kill 前落 partial output
```

DockerBackend / HostBackend 透传，不引入新状态。

### Idle / busy ceiling 计时算法

`SessionRecord` 扩字段（**busy 在 record 上持有**，订阅 `onBusyChange` 时同步写 `record.busy`，reschedule 同步读取）：

```text
busy:                boolean       (订阅 onBusyChange 写入)
detachedSince:       sockets.size 从 >0→0 时刻; sockets 回升时清空
notBusySince:        busy 从 true→false 时刻; busy=true 时清空
detachedBusySince:   (sockets===0 && busy) 起算; 任一条件翻转清空
idleTimer / busyCeilingTimer / busyUnsubscribe   计时器与订阅取消引用
```

唯一的 `reschedule(record)` 函数，在以下事件被调（任一发生都要重算）：

- socket attach / detach
- busy true→false / false→true（通过 `onBusyChange` 订阅）

```text
reschedule(record):
  cancel record.idleTimer
  cancel record.busyCeilingTimer

  if record.sockets.size > 0:
    return

  if !record.busy:
    // 客户端断开 且 任务空闲, 才开始 idleTimeoutMs
    base = max(record.detachedSince, record.notBusySince ?? record.detachedSince)
    remaining = max(0, idleTimeoutMs - (now - base))
    arm idleTimer for remaining:
      on fire -> handle.destroy(force=true)
    return

  // sockets.size === 0 && busy: 仅 arm 兜底
  remaining = max(0, maxDetachedBusyMs - (now - record.detachedBusySince))
  arm busyCeilingTimer for remaining:
    on fire ->
      emit metric 'idle_busy_timeout_total'
      await handle.persistInProgressTurn()   // 落 partial assistant text
      handle.destroy(force=true)
```

要点：

- `idleTimer` 只在 (detached && !busy) **同时**成立时 arm；任一条件翻转立即取消。
- `busyCeilingTimer` 只在 (detached && busy) 同时成立时 arm；busy→false 时取消并由 `idleTimer` 接管，**不叠计**。
- `maxDetachedBusyMs` 基于 `detachedBusySince`，busy 来回翻转一次就重置——它度量的是"连续 detached + 连续 busy"的持续时间，不是累积。
- AskUserQuestion 期间 busy=true：用户离线且不回答时，最终由 `busyCeilingTimer` 兜底回收。`persistInProgressTurn()` 保证 partial assistant text + `killed_by_idle_busy_timeout` 事件落 transcript，不丢。

### 参数默认建议

```text
session.idleTimeoutMs              = 10 分钟
session.maxDetachedBusyMs          = 2 小时
docker.userContainerIdleTimeoutMs  = 20 分钟
```

## 销毁时机

session 与用户容器是两层独立 idle 计时：

```text
session:        idleTimeoutMs + maxDetachedBusyMs   决定何时杀 scode
user container: userContainerIdleTimeoutMs          决定何时停用户容器
```

> **Transcript 保留**：A3 把 transcript 迁出 configDir 后，session destroy 时清 configDir / tmp / runtime / scode-home，但**不**删除 `<runtimeDir>/sessions/<sid>/transcript/` 目录。`GET /sessions/:id/context` 在 session destroy 后仍能读到历史记录（迁移前的老行为是 transcript 随 configDir 一起删，A3 之后修正）。

完整流程：

```text
用户断开所有客户端
  -> session runner 将 session 标记为 detached, 记录 detachedSince = now
  -> 如果 scode 仍在执行任务 (busy=true):
       arm busyCeilingTimer (基于 detachedBusySince)
       不 arm idleTimer
  -> scode 完成任务时 (busy=false 翻转):
       cancel busyCeilingTimer
       arm idleTimer with full idleTimeoutMs (基于 notBusySince)
  -> idleTimer 到期 -> runner 调 handle.destroy(force=true) kill scode
  -> busyCeilingTimer 到期:
       emit metric 'idle_busy_timeout_total'
       await handle.persistInProgressTurn()
       handle.destroy(force=true)
  -> 任一 timer 到期前重新 attach 客户端 -> 两个 timer 都 cancel, detachedSince 清空

session 销毁完成后:
  -> 若该用户没有其他 active/detached session -> 用户容器进入 idle 计时
  -> 超过 userContainerIdleTimeoutMs 后, moss-server 停止并删除用户容器
```

注意：session 是否可销毁不能只看"没有客户端连接"。当前代码里 idle timer 的触发条件主要是 `#clients.size === 0`（见 `sessionRunnerDaemon.ts:401`），也就是用户关闭页面或断开 WebSocket 后立即开始计时。用户级容器方案下必须叠加上一节的 busy 状态机；**`idleTimeoutMs` 的起算点改为 `max(detachedSince, notBusySince)`，而不是 `detachedSince` 本身**。

### maxDetachedBusyMs 语义补充

度量的是"**连续** detached + **连续** busy"的持续时间：

- 客户端断开期间，busy 任何一次 true→false→true 翻转，`detachedBusySince` 都要清空并在 busy 再次为 true 时重新记录。
- 这样长任务跑完中间空闲再启动新 turn，不会把前面的 busy 时长算进来。
- 兜底动作（`persistInProgressTurn` + `destroy(force=true)`）的目的是"用户彻底离线、scode 卡死或 AskUserQuestion 无人回答"这一类场景，不是"用户跑很多个任务"。

### ensureUserContainer 与销毁的互斥

`RuntimeService.ensureUserContainer(orgId, userId)` 和"用户容器 idle 销毁"必须串行化，否则：

```text
T0  最后一个 session 销毁 -> 启动 idle timer
T1  20 分钟到期 -> 计划 docker stop
T1+ε 用户打开新会话 -> ensureUserContainer 看到容器还在 -> 复用
T1+1s docker stop 落地 -> 新会话立即崩
```

要点：

- per-(org, user) 的 ensure 锁参照 `runtimeService.ts` 已有的 `pendingEnsures` 模式扩展。
- 容器状态机扩展四个状态：`starting / running / draining / dead`。`draining` 状态下 `ensureUserContainer` 必须等 `dead` 后重新 `starting`，或直接拒绝并让上游重试。
- 进入销毁前 double-check："该 user 下无 `status in ('creating','active','detached')` 且 `desired_state = 'active'` 的 session"。检查与状态变更必须在同一把锁内。
- 销毁完成后清掉 `UserContainerRegistry` 里对应记录，下一次 ensure 走全新创建。

### busy 与销毁触发条件

可以销毁当前 session 的 `scode`（idleTimer 触发路径）：

```text
sockets.size === 0
且 busy === false
且 now - max(detachedSince, notBusySince) >= idleTimeoutMs
```

兜底销毁路径（busyCeilingTimer 触发）：

```text
sockets.size === 0
且 busy === true
且 now - detachedBusySince >= maxDetachedBusyMs
触发动作: persistInProgressTurn() -> destroy(force=true)
```

可以销毁用户容器：

```text
同一 org/user 下:
  没有 status in ('creating','active','detached') 的 session
  且 desired_state = 'active' 的 session 数 = 0
  且该状态持续 >= userContainerIdleTimeoutMs
  且容器状态为 running（不在 draining/dead）
  且 ensureUserContainer 锁已拿到
```

### 用户容器 idle 计时基准点

要避免"永远不到 0"（计数 bug 导致 timer 不启）和"被新 session 续命到天荒地老"（reset 时机错）两种 bug：

```text
resetUserContainerIdleTimer(key) 触发点:
  1. releaseSession 后 activeSessionIds.size === 0 (最后一个 session 销毁)
  2. ensureUserContainer 完成且 activeSessionIds 仍为 0 (容器创建后无 session 进来的兜底)

cancelUserContainerIdleTimer(key) 触发点:
  1. acquireSession 后 activeSessionIds.size === 1 (从 0 → 1)
  2. 容器进入 'draining' / 'dead' 状态 (此时 reclaim 在跑, timer 无意义)
  3. registry 整体 shutdown
```

reset 时要 cancel 再 set 整段新 timer，不要"延长"已有 timer——这两种语义在边界条件下结果不同。

注意：上一稿写的 `acquireSession 计数从 1 → 0` 是错的——`acquireSession` 是计数 +1。最后一个 session 销毁触发的是 `releaseSession`，计数减到 0 时启动 idle timer。

## `scode` 进程销毁机制

现有 session 销毁链路是 session 级的：

```text
terminateSession(sessionId)
  -> moss-server 主进程给 runnerPid 发送 SIGTERM
  -> direct-connect-session-runner 收到 SIGTERM/SIGINT
  -> runner 调用 handle.destroy(true)
  -> AcpBridge.destroy(true) 给子进程发送 SIGKILL
  -> DockerBackend.cleanupRuntimeArtifacts() 兜底 docker rm -f 容器 + rm -rf configDir(session 模式)
```

在当前每 session 一个容器的模式下，AcpBridge 的子进程是 `docker run ... scode acp ...`。杀掉这个宿主机上的 `docker run` 进程后，容器内的 `scode` 通常会随容器退出；再加上 `--rm` 和 backend 的 `docker rm -f` 兜底，清理边界比较明确。

切到用户级容器后：

- AcpBridge 的子进程会变成 `docker exec ... scode acp ...`。
- **杀宿主机上的 `docker exec` CLI 进程不会自动杀掉容器内的 scode**——这是 Docker 的已知行为：`docker exec` 的客户端进程被信号打断时，容器内目标进程不会自动收到对应信号。
- `docker rm -f` 这条兜底路径**不能保留**，否则会误伤同容器内其它 session 的 scode 进程。

因此必须引入容器内 reaper 机制。

### Launcher 与 reaper

镜像里固化两个小脚本，由 `deploy/runtime/Dockerfile` 安装：

```text
/usr/local/bin/moss-session-launch <sessionId> -- <cmd...>
/usr/local/bin/moss-session-reap   <sessionId>  [--grace-ms N]
```

launcher 关键逻辑：

```text
#!/bin/sh
SID="$1"; shift              # 取 session id 并从参数列表移除
[ "${1:-}" = "--" ] || { echo "usage: ... <sid> -- <cmd...>" >&2; exit 2; }
shift                        # 跳过分隔符 --

RT_DIR="${MOSS_RUNTIME_DIR:-/data/runtime}"
META="$RT_DIR/sessions/$SID/runtime"
mkdir -p "$META"

echo "$SID" > "$META/scode.session_id"

# setsid 单独建立 process group; 内层 shell 在 exec 前写 pidfile + start_ticks
# exec 不改变 PID 也不改变 starttime, reaper 后续对账时单位/数值都对得上
exec setsid sh -c '
  PID=$$
  echo "$PID" > "'"$META"'/scode.pid"
  awk "{print \$22}" "/proc/$PID/stat" > "'"$META"'/scode.start_ticks"
  exec "$@"
' _ "$@"
```

要点：

- **必须 `setsid`**。scode 会 fork bash 工具、MCP 子进程。只杀 scode 顶层 PID 会留孤儿，kill `-PGID` 才能一次性杀干净。
- `scode.pid` 是 setsid 内层 shell 的 `$$`，exec scode 后 PID 不变，PGID 与 PID 相同。
- `scode.start_ticks` 取自 `/proc/<pid>/stat` 第 22 字段（**clock ticks since boot**）。**必须**与 reaper 用同源单位——不能用 `date +%s%N`（墙钟纳秒，参考点是 epoch），两者参考点和刻度全部不同，对账永远不会相等。
- `scode.session_id` 是文本兜底，给运维 / 调试用。

reaper 关键逻辑：

```text
#!/bin/sh
SID="$1"
GRACE_MS="${2:-5000}"

RT_DIR="${MOSS_RUNTIME_DIR:-/data/runtime}"
META="$RT_DIR/sessions/$SID/runtime"
PIDFILE="$META/scode.pid"
TICKSFILE="$META/scode.start_ticks"

[ -f "$PIDFILE" ] || exit 0

PID=$(cat "$PIDFILE")

# 进程已退出 → 仅清理元数据
[ -r "/proc/$PID/stat" ] || { rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"; exit 0; }

# PID 复用校验：同单位对账 (/proc/.../stat 第 22 字段, clock ticks since boot)
if [ -r "$TICKSFILE" ]; then
  CUR_TICKS=$(awk '{print $22}' "/proc/$PID/stat")
  REC_TICKS=$(cat "$TICKSFILE")
  if [ "$CUR_TICKS" != "$REC_TICKS" ]; then
    rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"
    exit 0   # PID 已复用, 跳过 kill 避免误杀别人
  fi
fi

# 按 PGID 杀树
kill -TERM -- -"$PID" 2>/dev/null
SLEEP_S=$(awk -v ms="$GRACE_MS" 'BEGIN { print ms/1000 }')
sleep "$SLEEP_S"
if kill -0 "$PID" 2>/dev/null; then
  kill -KILL -- -"$PID" 2>/dev/null
fi
rm -f "$PIDFILE" "$TICKSFILE" "$META/scode.session_id"
```

### DockerBackend 销毁顺序

#### AcpBridge 接口约定（按 containerMode 分流 destroy）

`createAcpBridgeHandle` 显式收 `containerMode: 'session' | 'user'` 参数，destroy 行为按模式分两套：

```text
handle.destroy(force):
  - containerMode === 'session' (老路径):
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
      // 容器随 --rm 自毁, scode 死
  - containerMode === 'user' (新路径):
      handle.child.stdin?.end()
      // 不 kill child, 不发信号; 真 kill 由 DockerBackend.cleanupSessionArtifacts 调 reaper

handle.persistInProgressTurn(): Promise<void>
  // 在 maxDetachedBusyMs 兜底 kill 之前调; 把 currentAssistantText 落 transcript
  // 并写一条 'killed_by_idle_busy_timeout' 事件
```

#### 五步主路径（user 模式）

user 模式下 `handle.destroy(force)` 的实际执行序列：

```text
Step 1.  if (!force) await handle.persistInProgressTurn()
         // 落 partial assistant text + 'killed_by_idle_busy_timeout' 事件到 transcript
         // force=true 路径跳过 (用户主动强杀, 不保留 partial)

Step 2.  docker exec <userContainer> moss-session-reap <sid> <graceMs>
         graceMs = force ? 0 : docker.execKillGraceMs
         // reaper 内部按 PGID + start_ticks 校验杀树
         // hard timeout = graceMs + 2000ms 兜底
         // reap 超时 / 失败 -> 记 metric, 继续 step 3 (不抛)

Step 3.  关闭 / 等待 host 侧 docker exec CLI 子进程退出
         await waitForChildExit(handle.child, timeout = 3s)
         if (still alive after timeout):
           handle.child.stdin?.end()      // 已在 AcpBridge.destroy 里关过, 兜底再关
           handle.child.kill('SIGKILL')   // 仅清理 host fd, scode 已死
           metric 'host_exec_force_kill'

Step 4.  磁盘清理 (runner 进程内执行)
         await rmrf(<runtimeDir>/sessions/<sid>/tmp)
         await rmrf(<runtimeDir>/sessions/<sid>/runtime)     // 含 scode.pid / scode.start_ticks
         await rmrf(<runtimeDir>/sessions/<sid>/scode-home)  // A1 引入
         if (dockerMode === 'session'): await rmrf(configDir)
         // 注意: transcript 已迁出 configDir (A3), 此步不再删 transcript

Step 5.  registry.releaseSession  ← 不在 runner 内调
         由主进程 child.once('close') handler 触发 (§"进程边界")
```

#### 两种容器模式的销毁语义差异（实现者必看）

```text
containerMode = session (老模式):
  AcpBridge.destroy 给 docker run 子进程发信号 → 容器随 --rm 自毁 → scode 死
  docker rm -f 是兜底
  → 信号路径是主要清理路径

containerMode = user (新模式):
  AcpBridge.destroy 仅关 stdin, 不发信号给 docker exec CLI 子进程
  容器内 scode 不会自动退 (docker exec 不转发信号到 exec 目标)
  → moss-session-reap 在容器内 kill -PGID 才是真正的清理主路径
  → destroy(force=false) 也必须 reap, 不能依赖 stdin EOF / SIGPIPE 让 scode 自己退
```

#### `force` 参数在新模式下的重定义

```text
destroy(force=false)  cleanup 前 await persistInProgressTurn()
                      reap --grace-ms = docker.execKillGraceMs (默认 5000ms)
                      reaper 先 SIGTERM 等 grace 再 SIGKILL
destroy(force=true)   cleanup 跳过 persistInProgressTurn
                      reap --grace-ms = 0
                      reaper 立即 SIGKILL, 不保留 partial
```

明确的 NOT 做事项：

- **不调用 `docker rm -f <userContainer>`**。
- **不调用 `docker stop <userContainer>`**。
- **runner 内不调 `registry.releaseSession`**——拿不到 registry，由主进程 child close 触发。

用户容器的生命周期由 `RuntimeService.UserContainerRegistry` 单独管理。

异常路径：

- 如果 `moss-session-reap` 找不到 pidfile / 进程已死 → 视为成功，继续清理 tmp/runtime 目录。
- 如果 reap exec 自身失败（容器死了、docker daemon 不通）→ **不**升级为 `docker rm -f`（会误伤其他 session）。记 metric，把孤儿信息留给 `reconcileOnStartup` 兜底。

### Runner 异常退出 / moss-server 重启

runner 异常退出或 moss-server 重启时，pidfile 可能指向容器内仍存活的 scode 进程。`reconcileOnStartup` 必须扫描活跃 attempt 并按上面的 TERM/KILL 流程回收。

用户容器整体销毁命令（仅由 `UserContainerRegistry` 调用）：

```text
docker stop --time <dockerStopTimeoutSec> moss-user-<hash(orgId:userId)>
docker rm   moss-user-<hash(orgId:userId)>
```

`--restart=no` 保证 stop 后不会被 daemon 自动拉起。idle 计时和销毁逻辑由 moss-server 主进程负责，不由 session runner 负责——runner 是每个 session 独立进程，本地引用计数无法可靠判断同一用户的其他 session 是否还在运行。

## Reconcile 矩阵

moss-server 启动时（或周期性自检）需要把"宿主机用户容器 × DB sessions × 容器内 pidfile"三轴拉直。处置矩阵：

**关键事实**：reattach 仅在 runner 进程活时可用。代码依据 `sessionRunnerDaemon.ts:110-117`——runner 持有 unix socket `attachPath` 监听端，主进程 reattach 实际是连这个 socket。runner 死了 socket 就死，**即便容器内 scode 还活着，stdio 也由已死 runner 持有，不可转交**。

因此矩阵必须扩展为四轴：宿主机用户容器、DB session 记录、**runner pid 活**、容器内 probeResult（基于 `/proc/<pid>/stat` 第 22 字段 + `scode.start_ticks` 对账）。

probeResult 枚举：

```text
'alive'             pidfile 存在 + PID 还在 + start_ticks 匹配
'dead'              pidfile 存在但 PID 不在 / start_ticks 文件缺失
'stale_pid_reuse'   pidfile 存在 + PID 还在 但 start_ticks 不匹配 (PID 已被复用)
'missing'           pidfile 不存在
```

矩阵（仅列 user 模式；session 模式走老 reattach-or-resume 路径不动）：

| 宿主机容器 | DB session | runner pid 活 | probeResult | 处置 |
|---|---|---|---|---|
| 在 | 有 | 是 | alive | reattach（老路径，仍可用） |
| 在 | 有 | 是 | dead / missing / stale_pid_reuse | terminate runner + reaper + resume from transcript |
| 在 | 有 | **否** | alive | **不 reattach**；reaper 杀孤儿 scode + resume；metric `reconcile_orphan_scode_total +1` |
| 在 | 有 | 否 | stale_pid_reuse | 清元数据 + resume；metric `reconcile_pid_reuse_total +1` |
| 在 | 有 | 否 | dead / missing | 清元数据 + resume |
| 在 | 无 | — | alive / stale | 孤儿 scode → reaper |
| 在 | 无 | — | dead / missing | 清 `<sid>/{tmp,runtime,scode-home}` |
| 在 | 无 | — | — (容器无引用) | 进入 idle 计时或立即 stop |
| 不在 | 有 | — | — | ensureUserContainer 后 resume |
| 不在 | 无 | — | — | 干净 |

并行的孤儿宿主机容器扫描：

```text
docker ps --filter label=moss.kind=user-container --format ...
  对每个容器:
    - moss.org / moss.user 解析不出对应活用户 -> docker rm -f
    - moss.image.digest 或 moss.runtime.config.hash 与当前一致性配置不符 -> 无活跃 session 时重建（见"容器升级"）
```

孤儿 tmp / runtime 目录扫描：

```text
ls <runtimeDir>/sessions/<sid>/{tmp,runtime}
  对每个目录:
    - DB 中无对应 session 且容器内无对应 pidfile 进程 -> rm -rf
```

## 实现位置

当前进程结构是：

```text
moss-server 主进程
  -> 每个 attempt 启动一个 direct-connect-session-runner 进程
    -> runner 内部创建 RuntimeBackend
      -> DockerBackend
        -> 当前执行 docker run
```

推荐实现边界：

- **用户容器创建、复用、idle 回收**放在 moss-server 主进程，靠近 `RuntimeService`。新增 `UserContainerRegistry` 模块，挂在 `RuntimeService` 上。
- `RuntimeService.spawnAttempt()` 在启动 session runner 前调用 `ensureUserContainer(orgId, userId)` + `acquireSession(...)`，确保用户容器已存在并通过状态机校验。
- runner manifest 中带上用户容器名、container mode、launcher 路径、per-session 路径（pidfile / tmp / scode-home）。
- `DockerBackend` 根据 manifest 中的 `containerMode` 选择：
  - `containerMode=session`：保留当前 `docker run --rm` 行为，老路径保留至少一个发布版本作为回退开关。
  - `containerMode=user`：改为 `docker exec -i <userContainer> moss-session-launch ... -- scode acp ...`，且**runner 不持有 registry 引用**。
- `AcpBridge` 显式收 `containerMode` 参数，destroy 行为按模式分流（见 §"DockerBackend 销毁顺序"）。

### 进程边界（关键约束）

`UserContainerRegistry` 只活在主进程。代码现状（`runtimeService.ts:154-174 spawnSessionRunner()` 和 `runtimeService.ts:1013-1039`）显示 runner 是 detached 子进程，与主进程**无共享内存**——仅通过 manifest 文件 + DB + attach socket 通信。任何把 registry 调用塞进 `DockerBackend.spawn()` 的方案都拿不到主进程的 registry 实例。

正确职责分工：

```text
主进程 (RuntimeService):
  - 持有 UserContainerRegistry 单例
  - spawnAttempt 内: ensureUserContainer + acquireSession
  - 写 manifest: userContainerName / containerMode / per-session 路径
  - 拉起 runner, 注册 child.once('close') handler 触发 releaseSession (release 主路径)
  - heartbeat 超时 / reconcileOnStartup / 周期性 reconcile 作为兜底 release 触发源

runner 子进程 (sessionRunnerDaemon + DockerBackend):
  - 从 manifest.session.runtime 读 userContainerName / containerMode / per-session 路径
  - 只做 docker exec, **不调任何 registry 方法**
  - 销毁链 (handle.destroy) 完成 step 1-4 (persist + reaper + host fd 兜底 + 磁盘清理)
  - runner 自然退出 / 异常 / crash 都触发主进程 child 'close', release 由主进程完成
```

`session` 模式下 runner 也不需要 registry，DockerBackend 直接 `docker run --rm`，老路径完全不动。

#### Release 触发链（多级保险）

```text
主路径:   主进程 child.once('close') -> registry.releaseSession()
兜底 1:   heartbeat 超时 (现状 sessionRunnerDaemon.ts:92-95 已有) -> kill runner pid + release
兜底 2:   reconcileOnStartup (moss-server 重启) 重建 activeSessionIds (§"Reconcile 矩阵")
兜底 3:   周期性 reconcile (后续可选增强) 修正 registry 与 DB / 容器内 pidfile 偏差
```

不引入 DB 事件 listener（项目现状没有可复用机制，新增成本大于收益）。DB 视为权威只读源，主路径 + 三级兜底足够。

#### UserContainerRegistry 内部并发模型

`ensureLock` 单 Promise 模型在 starting/draining/dead 三态转换并发场景下会出现 TOCTOU race（并发 ensure 看到 dead → 各自 delete + new record → 起出两个容器）。**必须**用真正的 per-key mutex 串行化所有状态变更：

```text
mutex = new PerKeyMutex()
ensure / acquire / release / onIdleFire / touchRebuildHash 全部走 mutex.run(key, fn)
状态机变更在锁内, 对外只暴露 stable 状态 (running 或不存在)
```

实现细节见实现方案 §C1 "Per-key mutex"。

### Idle timer 单一接管者

代码现状里有**两条** idle 路径：

```text
sessionManager.ts:#armIdleTimeout       (moss-server 主进程的 SessionManager)
sessionRunnerDaemon.ts:#idle 检测       (runner 进程内)
```

新模式下两条必须明确归属，避免两套 idle 同时跑、阈值不一致：

- runner 内的 idle 检测**保留**，负责 scode 进程级 idle（detached + not busy → kill scode）。
- SessionManager 这条**继续保留**用于 socket 级清理，但 idle 触发 destroy 的最终判定（busy / pending tool / pending AskUserQuestion）必须来自 runner 上报的状态，不再单纯按 socket 数判定。
- 用户容器级 idle 由 `RuntimeService.UserContainerRegistry` 独立计时，**不依赖**前两条。

如果想进一步简化，可以把 SessionManager 的 idle 路径砍掉，统一收敛到 runner + `RuntimeService` 两层，但这是单独的重构任务，本设计不强制。

### SessionRuntimeInfo / DB schema 演进

代码现状 `SessionRuntimeInfo` 持久化了 `containerName: 'moss-session-<sid12>'`，在 reconcile 时被读取。新模式下：

- 新增字段 `userContainerName`（如 `moss-user-<hash>`），写入 DB。
- 保留 `containerName` 字段以兼容老数据；新模式下其值与 `userContainerName` 相同或留空，由迁移脚本决定。
- 新增字段 `inContainerPidFile`（容器内 pidfile 绝对路径）、`tmpDirInContainer`（容器内 tmp 绝对路径），写入 DB。
- 新增字段 `containerMode: 'session' | 'user'`，方便 reconcile 区分老数据。

迁移策略：

```text
启动时遇到 containerMode 缺失的旧记录:
  - 视为 'session' 模式（老行为）
  - 走原 reattach/resume 流程
  - 不要尝试 attach 进 user container（因为没记 user container 名）
```

DB schema 写入点在现有 `sessions` / `attempts` 表内扩字段，避免新表（避免迁移风险）。

### UserContainerRecord 数据结构

挂在 `RuntimeService` 上的内存表：

```text
UserContainerRegistry: Map<`${orgId}:${userId}`, UserContainerRecord>

UserContainerRecord {
  key:                `${orgId}:${userId}`,
  containerName:      string,            // moss-user-<hash>
  containerId:        string,
  imageDigest:        string,            // 用于检测镜像升级
  configHash:         string,            // 用于检测配置升级
  createdAt:          number,
  lastActiveAt:       number,
  activeSessionIds:   Set<string>,
  idleTimer:          NodeJS.Timeout | null,
  state:              'starting' | 'running' | 'draining' | 'dead',
  pendingRebuild:     boolean,                // hash 不一致, 等无活跃 session 后重建
  // 注: 不持有 ensureLock; 状态机变更走外层 PerKeyMutex (见 §"实现位置 → 进程边界")
}
```

`SessionRecord` 扩展（`sessionManager.ts`）：

```text
SessionRecord {
  ...原字段...
  userContainerKey:    string,
  inContainerPidFile:  string,
  tmpDirInContainer:   string,
  scodeHomeDir:        string,           // A1: SUDO_CODE_CONFIG_HOME
  busy:                boolean,           // A2: 订阅 onBusyChange 写入
  detachedSince:       number | null,
  notBusySince:        number | null,
  detachedBusySince:   number | null,
  idleTimer:           Timer | null,
  busyCeilingTimer:    Timer | null,
  busyUnsubscribe:     (() => void) | null,
}
```

## 容器升级与 label

长生命周期容器会继续使用旧镜像。需要在容器 label 中写入足够信息，下次 ensure 时检测一致性：

```text
moss.kind=user-container
moss.org=<orgId>
moss.user=<userId>
moss.image=<image>
moss.image.digest=<sha256:...>
moss.runtime.config.hash=<configHash>
```

`configHash` 输入建议至少包含：

- `MOSS_HOME` 路径
- 容器级 env passthrough key 列表（不含值，避免 token 进 hash）
- mount layout（`<runtimeDir>` 路径、`<MOSS_HOME>` 路径）
- pids-limit / memory / cpus 等资源参数
- launcher / reaper 脚本的 hash

`ensureUserContainer` 时如果发现 label 与当前期望不一致：

- 该用户**无活跃 session** → drain 并重建。
- 该用户**有活跃 session** → 标记 `pendingRebuild=true`，等待所有 session 结束后重建。新进的 session 复用现有容器（避免阻塞）；持续累积时配合监控告警。

## 风险和注意事项

- **同用户互信假设**：`SESSION_TOKEN`、`SUDOWORK_AUTH_PROXY_TOKEN` 等是 session 级环境变量，同一用户容器内多个进程可以通过 `/proc/<pid>/environ` 互相读取。叠加 `SYS_ADMIN + seccomp=unconfined + danger-full-access + --user 共用 UID`，**用户容器内 session 互信 = 同一 Linux 用户互信**。这只有在"同一用户的 session 可互信"的前提下才是可接受的。文档级别要写明，不要让安全模型变成隐性假设。
- **PID 复用 / pidfile 校验**：容器长生命周期意味着 PID 复用是必然事件。reaper 不做 `/proc/<pid>/stat` starttime 比对就会偶发误杀。详见"scode 进程销毁机制 → reaper"。
- **`setsid` 不可省**：scode 会 fork bash 工具和 MCP 子进程，必须按 PGID 杀树。
- **镜像升级**：长生命周期容器会继续使用旧镜像。`configHash` 校验 + 无活跃 session 时重建，详见"容器升级与 label"。
- **容器名命名**：不要直接用 `userId`。建议 `moss-user-<hash(orgId:userId)>`，并加入部署或 server 前缀，避免多个 org 或多个 moss 实例共用 Docker daemon 时撞名。
- **集群路由**：用户级容器模式默认假设单机部署，或者负载均衡具备 sticky routing。集群场景下，同一用户的 session 必须路由到拥有该用户容器的节点，否则 `ensureUserContainer` 会在多节点重复创建容器。这是部署侧约束，文档应当提示，不在 moss-server 内强行解决。
- **`--restart=no`**：异常崩溃后由 moss-server 决策（走 reconcile），不要让 Docker 自动重生半破容器。
- **资源闸门**：参考"资源闸门与安全模型"。默认 `pids-limit=512 / memory=4g / cpus=2 / nofile=4096`，按环境调整。

## 测试要点（最少集）

| 测试 | 关注点 |
|---|---|
| 单容器内并发 N 个 scode，各自独立 transcript & cwd | 隔离正确性 |
| reap session A，session B 不受影响、ACP 不断 | **核心保障** |
| TMPDIR 隔离：A 在自己 tmp 写大文件后 reap，磁盘空间释放、B 无影响 | TMPDIR 边界 |
| pids-limit 触发：A fork 风暴时 B 不受影响、容器不死 | 资源闸门 |
| `pendingEnsures` 锁：并发 ensure 同一用户容器只产生一个容器 | 去重锁 |
| `draining` 状态下 ensure 是等待还是拒绝、行为符合状态机定义 | 销毁/创建互斥 |
| 容器内 OOM-killed → 所有 attached session 标记 lost 并恢复 | 灾难恢复 |
| `dockerMode=user` 下两个 scode 同时写 assistant override / shared memory | 共享 configDir 并发 |
| `sudocode.json` / `settings.json` 改走 per-session 目录后，scode 启动读到正确配置 | 共享 configDir 写并发整改验证 |
| Reconcile：宿主机有孤儿容器 / 容器内有孤儿 pidfile / DB 有孤儿 session 三种组合 | reconcile 完整性 |
| 用户容器 idle 超时回收期间新 session 进来取消回收 | 取消语义 |
| 长任务跨过 `idleTimeoutMs` 才完成，busy→false 时重新 arm 完整 `idleTimeoutMs`，不立即 kill | **核心 idle regression** |
| detached + 持续 busy → `maxDetachedBusyMs` 兜底前 `persistInProgressTurn` 被调，partial assistant text 落 transcript | 兜底 + 不丢数据 |
| AskUserQuestion 期间用户离线 → busy 维持 true，由 `maxDetachedBusyMs` 而非 `idleTimeoutMs` 回收 | AskUserQuestion 兜底 |
| busy 来回翻转，`idleTimer` / `busyCeilingTimer` 正确取消/重算，时长不叠加 | 状态机正确性 |
| PID 复用：reaper 在 `start_ticks` 不一致时拒绝 kill | 误杀防御 |
| launcher / reaper 同源单位对账（`/proc/<pid>/stat` 第 22 字段），不混用 `date +%s%N` | 单位一致 |
| 杀 host 侧 `docker exec` 进程后容器内 scode **不**自动退出（验证信号不转发的事实）；后续 destroy 调 reaper 才真正清理 | 信号边界 |
| `destroy(force=true)` 路径 `reap --grace-ms=0`，`force=false` 路径 `reap --grace-ms=execKillGraceMs` | force 参数新语义 |
| 镜像升级 + 无活跃 session：自动 drain 并重建容器 | 容器升级 |
| 镜像升级 + 有活跃 session：标记 pendingRebuild，新 session 仍复用 | 升级降级路径 |
| `MOSS_HOST_PATH_MAP` 只覆盖 session 路径（未覆盖 runtimeDir 根）时启动失败可观测 | 配置兜底 |
| Reconcile **runner 死 + scode 活**：不尝试 reattach，必须 reap 孤儿 scode + resume；metric `reconcile_orphan_scode_total +1` | reattach 边界 |
| Reconcile probe 校验 `start_ticks`：PID 复用场景返回 `stale_pid_reuse` 走 resume；metric `reconcile_pid_reuse_total +1` | 误杀防御（reconcile 路径） |
| A3：session destroy 后 `GET /sessions/:id/context` 仍能读 transcript（不在 configDir 内，cleanup 不删） | transcript 独立目录 |
| A3 迁移脚本：已迁移 / 未迁移 / 丢失三种状态幂等；mock kill -9 后下次启动断点续传 | 迁移健壮性 |
| 主进程 runner `child.once('close')` 触发 release；session 模式不触发；kill -9 runner 也能正确 release | release 主路径 |
| UserContainerRegistry PerKeyMutex 并发：100 个 ensure/acquire/release/onIdleFire 混合无 race，单容器单实例 | mutex 正确性 |
| user 模式 AcpBridge.destroy 仅关 stdin、**不**给 child 发信号；真 kill 走 reaper 路径 | AcpBridge 分流 |
| 镜像依赖检测：CI 在镜像构建后 `docker run <image> sh -c 'command -v setsid && sleep 0.001 && command -v awk && [ -r /proc/self/stat ]'` 必须 exit 0，缺一 fail | 镜像依赖约束 |
| 监控指标无 user / session_id label（验证按 D2 §"Label 基数原则"配置） | 指标基数 |
