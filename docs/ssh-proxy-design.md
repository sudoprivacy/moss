# SSH 代理方案文档

## 背景

moss-server 运行在主机上，session 容器运行在 Docker 中。用户希望通过 SSH/sshfs 等标准工具连接到容器内部，但不暴露容器的端口到主机。

## 方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| SSH 跳板 | 使用标准 OpenSSH，稳定可靠 | 需配置主机 sshd，复杂 |
| HTTP CONNECT | 实现简单，几行代码 | 认证需要额外设计 |

---

## 方案一：SSH 跳板（ProxyJump）

### 架构

```
用户 SSH → 主机 sshd(跳板) → docker network → 容器 sshd:22
```

### 实现步骤

#### 1. 主机 sshd 配置

`/etc/ssh/sshd_config` 添加：
```ssh
Match User moss-*
    ForceCommand /usr/local/bin/moss-ssh-jump
    PasswordAuthentication yes
```

#### 2. 跳转脚本 `/usr/local/bin/moss-ssh-jump`

```bash
#!/bin/bash

# 用户名格式: moss-abc123
SESSION_PREFIX=$(echo "$USER" | sed 's/^moss-//')

# 查找容器（容器名格式: moss-session-abc123xxx-g1）
CONTAINER=$(docker ps --format '{{.Names}}' | grep "^moss-session-$SESSION_PREFIX" | head -1)

if [ -z "$CONTAINER" ]; then
    echo "Session not found"
    exit 1
fi

# 获取容器 IP
CONTAINER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER")

# 跳转到容器 SSH（使用跳板密钥）
exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -i /etc/moss/ssh_jump_key \
    root@$CONTAINER_IP
```

#### 3. SSH 跳板密钥配置

```bash
# 主机生成跳板密钥
ssh-keygen -t ed25519 -f /etc/moss/ssh_jump_key -N ""

# 公钥需要注入到所有容器
# 方式A：容器镜像内置公钥
# 方式B：容器启动时通过 docker exec 注入
```

#### 4. 容器信任主机密钥

容器内 `/root/.ssh/authorized_keys`：
```ssh
ssh-ed25519 AAAA... moss-jump-key
```

#### 5. 密码认证（可选）

使用 PAM 模块验证 API Token，或配置 `AuthorizedKeysCommand` 调用 moss-server API。

### 用户使用方式

```bash
# SSH 连接
ssh moss-abc123@moss-server-host

# sshfs 挂载
sshfs moss-abc123@moss-server-host:/workspace ./mount
```

### 流程

1. 用户 SSH 连接主机，用户名 `moss-abc123`
2. 主机 sshd 触发 ForceCommand
3. 脚本查找容器名和 IP
4. 脚本使用跳板密钥 SSH 到容器
5. 用户获得容器 shell

---

## 方案二：HTTP CONNECT 代理

### 架构

```
SSH客户端 → ProxyCommand(nc) → HTTP CONNECT代理 → 容器:22
```

### 原理

HTTP CONNECT 是标准 HTTP 方法，用于建立 TCP 隧道。代理不解析 SSH 协议，只做双向转发。

### 服务端实现

在 moss-server HTTP 服务中添加 CONNECT 处理：

```javascript
import net from 'net'

// HTTP server 添加 connect 事件处理
server.on('connect', (req, clientSocket, head) => {
  // req.url 格式: "moss-session-abc123:22"
  const [hostname, port] = req.url.split(':')

  // 从 hostname 提取 session ID
  // moss-session-abc123xxx-g1 -> 查找容器

  // 连接容器（通过 Docker network）
  const containerSocket = net.connect({
    host: hostname,  // 容器名作为 hostname
    port: parseInt(port) || 22
  })

  containerSocket.on('connect', () => {
    // 响应客户端，隧道建立成功
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // 双向转发
    containerSocket.pipe(clientSocket)
    clientSocket.pipe(containerSocket)
  })

  containerSocket.on('error', () => {
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
})
```

### 客户端配置

#### 方法 1：SSH ProxyCommand（推荐）

`~/.ssh/config`：
```ssh
Host moss-session-*
    ProxyCommand nc -X connect moss-server-host:43127 %h %p
    User root
```

使用：
```bash
ssh moss-session-abc123-g1
sshfs moss-session-abc123-g1:/workspace ./mount
```

#### 方法 2：用 curl 测试隧道

```bash
curl -v --proxy moss-server-host:43127 \
     --proxytunnel \
     -X CONNECT \
     moss-session-abc123:22
```

#### 方法 3：自定义 ProxyCommand（无 nc 时）

```python
#!/usr/bin/env python3
import socket, sys, select

host_port = sys.argv[1]
proxy_host, proxy_port = 'moss-server-host', 43127

s = socket.socket()
s.connect((proxy_host, proxy_port))
s.send(f'CONNECT {host_port} HTTP/1.1\r\n\r\n'.encode())

resp = s.recv(4096).decode()
if '200' not in resp:
    sys.exit(1)

# 双向转发
while True:
    r, _, _ = select.select([s, sys.stdin], [], [])
    if s in r:
        data = s.recv(4096)
        if not data: break
        sys.stdout.buffer.write(data)
    if sys.stdin in r:
        data = sys.stdin.buffer.read(4096)
        if not data: break
        s.sendall(data)
```

### 认证方案

HTTP CONNECT 不携带认证信息，有几种选择：

**方案 A：网络隔离**
- 只在内网开放代理端口
- 不做额外认证，简单

**方案 B：URL 携带临时凭证**
- 用户先 HTTP API 登录获取 session key
- CONNECT URL: `moss-session-abc123-key123:22`
- 代理验证 key 后建立隧道

**方案 C：SSH 层认证**
- 隧道建立后，认证由容器 sshd 处理
- 容器密码需要管理（固定密码或临时密码）

### 流程

1. SSH 客户端发送 CONNECT 请求
2. 代理解析 hostname 找到容器
3. 代理连接容器 SSH (22 端口)
4. 代理响应 `200 Connection Established`
5. SSH 协议在隧道中透传
6. 容器 sshd 处理 SSH 认证

---

## 推荐方案

### 如果 moss-server 在主机上

推荐 **SSH 跳板方案**：
- 利用现有主机 sshd，稳定
- 用户无需额外配置 ProxyCommand
- 认证可复用主机 SSH 机制

### 如果 moss-server 在 Docker 中

推荐 **HTTP CONNECT 方案**：
- 实现简单，几行代码
- 不需要配置 sshd
- 与现有 HTTP 服务共存

---

## 待确认事项

1. **容器 SSH 服务**：确认容器镜像已安装 sshd
2. **认证机制**：确定 API Token 如何与 SSH 认证结合
3. **端口选择**：HTTP CONNECT 需要单独端口（如 43127）还是共用 HTTP 端口

---

## 参考链接

- [HTTP CONNECT RFC 7231](https://tools.ietf.org/html/rfc7231#section-4.3.6)
- [SSH ProxyCommand](https://www.openssh.com/manual.html)
- [ssh2 Node.js 库](https://github.com/mscdex/ssh2)