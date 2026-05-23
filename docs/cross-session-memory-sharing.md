# 跨会话记忆共享实现逻辑

本文档记录 Moss Direct Connect runtime 中跨会话记忆共享的当前实现，包括 host 模式和 Docker 模式。

## 目标

跨会话记忆只在满足以下条件时共享：

- 当前 Assistant 的 `_moss_meta.json` 配置为 `memory_mode: "user"`。
- 当前会话 runtime mode 解析为 `user`，即 host 使用 `hostMode: "user"`，Docker 使用 `dockerMode: "user"`。
- 共享范围是同一个 `userId` + 同一个 `assistantName`。

如果 runtime mode 是 `session`，记忆只存在于单次会话目录中，不跨会话共享。

## 核心文件

当前实现主要涉及以下文件：

- `src/server/runtimeService.ts`：创建 session、解析 assistant `memory_mode`、准备 shared memory、写 manifest。
- `src/server/runtimePaths.ts`：根据 `session/user` mode 生成 runtime `configDir`。
- `src/server/sharedAgentMemory.ts`：共享记忆文件路径、读写、去重、锁、AGENTS.md override 生成。
- `src/server/backends/scodeBackend.ts`：host runtime 启动 scode，并设置 HOME/config env。
- `src/server/backends/dockerBackend.ts`：Docker runtime 启动容器、挂载 configDir，并设置 HOME/config env。
- `src/server/backends/acpBridge.ts`：首条消息注入 shared memory，并捕获可记忆用户事实写入记忆文件。
- `src/utils/scodeBridge.ts`：构造首条消息中的 assistant 规则、技能提示、shared memory fallback。

## 路径模型

### RuntimeService 路径

`RuntimeService.createSession()` 会先确定 runtime mode，再计算 `configDir`。

`user` 模式：

```text
<runtimeDir>/users/<userId>/config
```

默认本地路径示例：

```text
/Users/yobach/.moss/server/runtime/users/<userId>/config
```

`session` 模式：

```text
<runtimeDir>/sessions/<sessionId>/config
```

默认本地路径示例：

```text
/Users/yobach/.moss/server/runtime/sessions/<sessionId>/config
```

### 共享记忆文件

共享记忆按 Assistant 分目录：

```text
<configDir>/.moss/memory/<assistantName>/MEMORY.md
```

例如：

```text
/Users/yobach/.moss/server/runtime/users/<userId>/config/.moss/memory/微信公众号运营助手/MEMORY.md
```

### Assistant override 文件

运行时会生成：

```text
<configDir>/.nexus/sudocode/AGENTS.md
```

这个文件包含：

- Assistant 身份覆盖。
- 已读取到的 shared memory。
- Assistant system prompt。

注意：当前实现只写入 runtime `configDir`，不再写入 workspace 下的 `.nexus/sudocode/AGENTS.md`，避免把某个用户的记忆污染到同工作区的其他用户或其他会话。

## 创建会话时的解析链路

1. API 创建会话，传入 `assistantName`、`runtime`、`userId`。
2. `RuntimeService.createSession()` 读取 Assistant runtime 配置。
3. 如果 Assistant 配置为 `memory_mode: "user"`，且调用方没有显式传入 mode：
   - Docker runtime 设置 `dockerMode: "user"`。
   - Host runtime 设置 `hostMode: "user"`。
4. `mergeRuntime()` 合并 runtime 默认值和请求值。
5. `getSessionConfigDir()` 根据 mode 生成 `configDir`。
6. session 记录写入 DB，runtime 信息中包含 `configDir` 和 `hostMode/dockerMode`。

这一步决定了后续是否跨会话共享。共享本质上依赖多个会话复用同一个用户级 `configDir`。

## 启动 runner 前的记忆准备

`RuntimeService.spawnAttempt()` 会在启动 runner 前做以下事情：

1. 读取 Assistant meta。
2. 如果 `memory_mode === "user"`：
   - 读取登录用户资料。
   - 构造 profile memory，例如用户名、角色、部门、邮箱。
   - 追加到 `MEMORY.md`，重复内容会跳过。
   - 读取完整 `MEMORY.md` 作为 `sharedMemory`。
3. 写入 `<configDir>/.nexus/sudocode/AGENTS.md`。
4. 将 `sharedMemory` 放入 runner manifest：

```json
{
  "session": {
    "sharedMemory": "..."
  }
}
```

runner 启动后会把 manifest 中的 `sharedMemory` 传给 backend，再传给 `AcpBridge`。

## Host 模式

Host 模式由 `ScodeBackend` 启动本机 scode 进程。

### user 模式

当 `hostMode: "user"` 时：

```text
configDir = <runtimeDir>/users/<userId>/config
```

同一个用户、同一个 Assistant 的后续 host 会话会复用：

```text
<configDir>/.moss/memory/<assistantName>/MEMORY.md
```

scode 进程环境变量：

```text
HOME=<configDir>
CLAUDE_CONFIG_DIR=<configDir>
CLAUDE_CODE_REMOTE_MEMORY_DIR=<configDir>
```

因此 scode 的配置、自动记忆目录、Moss 共享记忆都基于同一个用户级 configDir。

### session 模式

当 `hostMode: "session"` 时：

```text
configDir = <runtimeDir>/sessions/<sessionId>/config
```

这类目录只属于当前会话。会话销毁时，host backend 会清理 session configDir，因此不会跨会话共享。

## Docker 模式

Docker 模式由 `DockerBackend` 启动容器。

### user 模式

当 `dockerMode: "user"` 时：

```text
configDir = <runtimeDir>/users/<userId>/config
```

Docker backend 会把以下目录挂载进容器：

```text
<workspace>:<workspace>
<configDir>:<configDir>
<MOSS_HOME>:<MOSS_HOME>
```

容器内环境变量：

```text
HOME=<configDir>
MOSS_HOME=<MOSS_HOME>
CLAUDE_CONFIG_DIR=<configDir>
CLAUDE_CODE_REMOTE_MEMORY_DIR=<configDir>
```

因此容器内可以访问同一份用户级文件：

```text
<configDir>/.moss/memory/<assistantName>/MEMORY.md
<configDir>/.nexus/sudocode/AGENTS.md
```

这使 Docker 会话也能跨会话共享记忆。共享不是通过 Docker volume 名称实现，而是通过 bind mount 同一个宿主机 `configDir` 实现。

### session 模式

当 `dockerMode: "session"` 时：

```text
configDir = <runtimeDir>/sessions/<sessionId>/config
```

Docker backend 仍会挂载这个目录进容器，但它是单次会话目录。容器销毁后，backend 会清理该 `configDir`，所以不会跨会话共享。

## 记忆注入链路

记忆有两条注入路径：

1. `AGENTS.md` override：
   - 生成在 `<configDir>/.nexus/sudocode/AGENTS.md`。
   - 包含 Assistant identity、shared memory、assistant rules。
   - host 和 Docker 都通过 `HOME/CLAUDE_CONFIG_DIR=<configDir>` 让 scode 有机会读取。

2. 首条消息 fallback：
   - `AcpBridge` 处理第一条用户消息时调用 `prepareFirstMessageForScode()`。
   - `sharedMemory` 会被拼进首条消息的 `[Shared User Memory]` block。
   - 这样即使 scode 未读取 AGENTS.md，模型仍能收到共享记忆。

这两条路径同时存在，是为了提高记忆注入可靠性。

## 记忆写入链路

运行时会自动写入两类记忆：

### Profile memory

每次启动 `memory_mode: "user"` 的 Assistant session 时，server 会从当前登录用户资料生成 profile memory，例如：

```text
The current logged-in user's name is ...
The user's role is ...
The user belongs to the ... department.
The user's email is ...
```

写入目标：

```text
<configDir>/.moss/memory/<assistantName>/MEMORY.md
```

### Explicit memory

`AcpBridge` 会检查用户消息，如果匹配显式记忆表达，会追加到 `MEMORY.md`。

当前支持的表达包括：

```text
记住...
请记住...
记录...
别忘了...
保存...
```

也支持部分 profile 句式，例如：

```text
我是...
我叫...
my name is ...
i am ...
```

写入时有以下保护：

- 内容会 trim 并规范换行。
- 完全相同内容忽略重复写入。
- 读改写过程使用目录锁。
- 写文件使用临时文件 + rename 原子替换。

## 当前边界和已知问题

- 共享粒度是 `userId + assistantName`，不是全局用户记忆。
- 当前会话中新写入的记忆会立刻落盘，但已注入到本轮会话上下文里的 `sharedMemory` 不会自动重载；通常从下一个会话开始稳定生效。
- `session` 模式不会跨会话共享，即使 Docker 也挂载了 configDir。
- RuntimeService 路径和旧 direct-connect fallback 路径不同：
  - RuntimeService：`~/.moss/server/runtime/users/<userId>/config`
  - 旧 backend fallback：`~/.moss/direct-connect-runtime/users/<userId>`
  两者不会互相共享。
- 当前 profile 句式识别较粗，类似“我是谁”可能被误识别为 “我是 + 谁”。需要进一步收紧规则。
- “我喜欢你用中文回答”这类偏好表达目前不一定会被写入，需要补充偏好类规则。

## 快速排查方法

给定 sessionId，可以先看 manifest：

```bash
jq '.session | {sessionId, userId, assistantName, runtime, sharedMemory}' \
  ~/.moss/server/runtime/sessions/<sessionId>/attempt-0001/manifest.json
```

看实际 configDir：

```bash
jq -r '.session.runtime.configDir' \
  ~/.moss/server/runtime/sessions/<sessionId>/attempt-0001/manifest.json
```

看共享记忆文件：

```bash
cat '<configDir>/.moss/memory/<assistantName>/MEMORY.md'
```

看 scode override：

```bash
cat '<configDir>/.nexus/sudocode/AGENTS.md'
```

看对话 transcript：

```bash
cat ~/.moss/server/transcripts/projects/<sanitized-cwd>/<sessionId>.jsonl
```
