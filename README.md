# Moss Server

Moss Server 是多用户 AI coding agent 服务。服务端通过 HTTP/WebSocket 提供管理、
认证和会话接口，在 Linux 宿主机运行编译后的 `moss-server.mjs`；每个用户会话在
Docker Runtime 中运行 `scode`。

## 文档

- [Moss Server API](src/server/API.md)
- [完整部署说明](deploy/README.md)
- [最新 Server Release](https://github.com/sudoprivacy/moss/releases/latest)

## 系统要求

- Linux x86_64 或 ARM64
- glibc 2.35+，推荐 Ubuntu 22.04 或更新版本
- systemd
- Docker 20.10+，且 Docker daemon 已启动
- root/sudo 权限
- `curl`、`tar`、`gzip` 和 `sha256sum`

安装包自带 Node.js 22、编译后的 `moss-server.mjs`、运行依赖和官方 Nexus，
不依赖系统 Node.js 或 Docker Compose。

## 一键安装

固定安装入口使用 GitHub 标准 Latest Release，URL 不随版本变化：

```bash
curl -fL --progress-bar https://github.com/sudoprivacy/moss/releases/latest/download/install.sh | sudo bash
```

安装器会提示安装目录、对外地址、管理员账号、密码及可选模型 API 配置。通过
`sudo` 安装时，默认目录是发起用户的 `$HOME/.moss/server`，systemd 服务也以
该用户运行；直接使用 root 安装时才会使用 `/root/.moss/server`。默认端口是
`43127`。

非交互安装：

```bash
curl -fL --progress-bar https://github.com/sudoprivacy/moss/releases/latest/download/install.sh \
  | sudo env MOSS_NON_INTERACTIVE=1 \
      MOSS_ADVERTISED_HOST=10.0.1.206 \
      MOSS_ADMIN_USERNAME=admin \
      MOSS_ADMIN_PASSWORD='replace-with-a-strong-password' \
      bash
```

指定其他目录时增加 `MOSS_INSTALL_DIR=/data/moss`；root 为其他用户安装时可以
增加 `MOSS_INSTALL_USER=username`。

GitHub Release 大文件访问受限时，可以使用同样固定的镜像入口：

```bash
BASE=https://ghfast.top/https://github.com/sudoprivacy/moss/releases/latest/download
curl -fL --progress-bar "$BASE/install.sh" | sudo env MOSS_DOWNLOAD_BASE="$BASE" bash
```

安装器会在下载大文件前确认脚本版本与 GitHub Latest 一致，并检查镜像中的
`SHA256SUMS` 是否包含当前架构的完整资产；下载完成后还会验证文件校验和。镜像
尚未同步时安装会中止。GitHub Latest 元数据不可达时默认告警后继续，可增加
`MOSS_REQUIRE_LATEST=1` 要求无法确认时也中止。

需要锁定版本或回滚时使用版本 URL：

```bash
curl -fL --progress-bar https://github.com/sudoprivacy/moss/releases/download/server-v0.1.4/install.sh \
  | sudo env MOSS_ALLOW_OLD_VERSION=1 bash
```

## 离线安装

下载与目标机器架构一致的离线包：

```bash
curl -fLO https://github.com/sudoprivacy/moss/releases/latest/download/moss-offline-0.1.4-linux-amd64.tar.gz
tar -xzf moss-offline-0.1.4-linux-amd64.tar.gz
cd moss-offline
sudo ./install.sh --offline
```

ARM64 机器将文件名中的 `amd64` 替换为 `arm64`。离线包包含宿主 Server、
Docker Runtime 镜像、安装器和 SHA-256 校验文件，安装过程不访问网络。

## 目录与配置

默认目录结构：

```text
~/.moss/server/
  current -> releases/server-vX.Y.Z
  releases/server-vX.Y.Z/   # Node.js、moss-server.mjs 和运行依赖
  data/                      # SQLite、transcript 和 session runtime 数据
  .moss/                     # 系统设置、Skill、Assistant 和 Nexus 数据
  server.json                # 服务、认证、存储和 Runtime 主配置
  moss-server.env            # systemd 环境变量
  start.sh
  stop.sh
  status.sh
  uninstall.sh
```

`server.json`、`moss-server.env` 和 `.moss/settings.json` 权限为 `600`。修改
`server.json` 后执行 `sudo systemctl restart moss-server` 生效。模型和 API Key
也可以通过管理后台的系统设置维护。

## 服务管理

```bash
sudo systemctl status moss-server
sudo systemctl start moss-server
sudo systemctl stop moss-server
sudo systemctl restart moss-server
journalctl -u moss-server -f
curl http://127.0.0.1:43127/healthz
```

安装完成后访问 `http://SERVER:43127/admin/`。

## 升级与卸载

再次执行一键安装命令即可升级。安装器自动发现已有 systemd 服务及安装目录，
保留配置和数据；新版本健康检查失败时会恢复上一版本。

保留配置和数据卸载程序：

```bash
sudo ~/.moss/server/uninstall.sh
```

删除程序、配置和全部运行数据：

```bash
sudo ~/.moss/server/uninstall.sh --purge
```

## 从源码构建

```bash
bun install
bun run build:node
```

生成文件包括 `bin/moss-server.mjs` 和
`bin/direct-connect-session-runner.mjs`。Release CI 会分别生成 amd64/arm64
宿主包、Docker Runtime 镜像、离线整包、`install.sh` 和 `SHA256SUMS`。
