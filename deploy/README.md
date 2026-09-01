# Moss Server 部署

Moss Server 在 Linux 宿主机上使用安装包自带的 Node.js 22 运行，用户会话在
Docker Runtime 镜像中运行。安装不依赖系统 Node.js 或 Docker Compose。

## 系统要求

- Linux x86_64 或 ARM64
- glibc 2.35+（Ubuntu 22.04 或同等级新版本 Linux）
- systemd
- Docker 20.10+，且 Docker daemon 已启动
- root 权限
- `tar`、`gzip`、`sha256sum` 和 `curl`

Nexus 使用 `https://github.com/nexi-lab/nexus` 发布的官方
`nexusd-cluster` 二进制，不在 Moss CI 中重新编译。该二进制及宿主原生依赖以
Ubuntu 22.04 为最低验证基线；Ubuntu 20.04 和 CentOS 7 会在安装器写入文件或
加载镜像前被拒绝。

## 在线安装

Server 是仓库唯一发布产品。Release CI 会将每个 `server-v*` Release 同步到腾讯
云 COS 并标记为 GitHub Latest。日常安装和升级使用以下 COS 全球加速固定命令，
URL 不随版本变化：

```bash
curl -fL --progress-bar https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh | sudo bash
```

每个服务端版本仍保留独立的 `server-v*` Release，锁定版本或回滚时可以使用：

```bash
BASE=https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/releases/server-v0.1.5
curl -fL --progress-bar "$BASE/install.sh" \
  | sudo env MOSS_DOWNLOAD_BASE="$BASE" MOSS_ALLOW_OLD_VERSION=1 bash
```

安装器会提示安装目录、端口、对外地址、管理员账号密码及可选 API 配置。默认
目录是发起安装用户的 `$HOME/.moss/server`，默认端口是 `43127`。通过 `sudo`
执行时根据 `SUDO_USER` 查询该用户的真实 home；直接以 root 执行时默认目录才是
`/root/.moss/server`。systemd 中始终写入解析后的绝对路径，不使用 `~`。
服务进程也以该用户运行；systemd 仅为服务补充 Docker socket 所属组。安装器和
systemd 单元的写入仍需要 root 权限。
升级已有服务且未显式指定目录时，安装器优先从现有 systemd 单元读取原目录，
不会因默认目录规则变化而迁移或新建数据。升级时保留原服务用户；安装器不自动
迁移已有目录的所有权。

也可以使用环境变量进行非交互安装：

```bash
curl -fL --progress-bar https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh \
  | sudo MOSS_NON_INTERACTIVE=1 \
      MOSS_INSTALL_DIR=/data/moss \
      MOSS_ADVERTISED_HOST=10.0.1.133 \
      MOSS_ADMIN_PASSWORD='replace-me' \
      bash
```

支持的变量包括 `MOSS_INSTALL_USER`、`MOSS_INSTALL_DIR`、`MOSS_PORT`、
`MOSS_ADVERTISED_HOST`、`MOSS_ADMIN_USERNAME`、`MOSS_ADMIN_PASSWORD`、`MOSS_DOWNLOAD_BASE`、
`MOSS_ALLOW_OLD_VERSION`、`MOSS_REQUIRE_LATEST`、`ANTHROPIC_BASE_URL` 和
`ANTHROPIC_API_KEY`。安装脚本默认从 COS 的不可变版本目录下载大文件；也可以通过
`MOSS_DOWNLOAD_BASE` 使用其他包含同一组 Release 资产的 HTTP 目录。

GitHub Release 备用源：

```bash
BASE=https://github.com/sudoprivacy/moss/releases/latest/download
curl -fL --progress-bar "$BASE/install.sh" | sudo env MOSS_DOWNLOAD_BASE="$BASE" bash
```

ghfast 备用入口：

```bash
BASE=https://ghfast.top/https://github.com/sudoprivacy/moss/releases/latest/download
curl -fL --progress-bar "$BASE/install.sh" | sudo env MOSS_DOWNLOAD_BASE="$BASE" bash
```

安装器先通过 GitHub Latest 的重定向确认脚本版本。镜像未同步 Latest 时会在下载
大文件前中止；随后检查镜像的 `SHA256SUMS` 是否包含当前版本和架构的 server、
Runtime 包，并在下载后校验内容。GitHub Latest 元数据不可达时默认告警并继续，
设置 `MOSS_REQUIRE_LATEST=1` 可改为直接失败。只有明确锁定旧版本或回滚时才应设置
`MOSS_ALLOW_OLD_VERSION=1`。

## 离线安装

在有网络的机器下载与目标架构对应的离线包并传到服务器：

```bash
tar -xzf moss-offline-0.1.5-linux-amd64.tar.gz
cd moss-offline
sudo ./install.sh --offline
```

离线包内已经包含宿主 server 包、Docker Runtime 镜像、安装器和 SHA-256
校验文件。安装过程不会访问网络。

## 目录与服务

默认目录结构：

```text
~/.moss/server/
  current -> releases/server-v0.1.5
  releases/server-v0.1.5/   # Node 22、moss-server.mjs 和运行依赖
  data/                      # SQLite、transcript 和 session runtime 数据
  .moss/                     # 设置、技能、assistant 和 Nexus 数据
  server.json
  moss-server.env
  start.sh
  stop.sh
  status.sh
  uninstall.sh
```

常用操作：

```bash
sudo ~/.moss/server/status.sh
sudo ~/.moss/server/stop.sh
sudo ~/.moss/server/start.sh
journalctl -u moss-server.service -f
curl http://127.0.0.1:43127/healthz
```

访问 `http://SERVER:43127/admin/`，使用安装阶段设置的管理员账号登录。

## 升级、回滚与卸载

执行新版本安装命令即可原地升级。安装器保留 `data`、`.moss` 和配置，切换
`current` 后等待健康检查；新版本无法启动时自动恢复原版本。

普通卸载保留数据和配置：

```bash
sudo ~/.moss/server/uninstall.sh
```

明确删除全部 Moss 数据：

```bash
sudo ~/.moss/server/uninstall.sh --purge
```

`--purge` 不会删除不属于 Moss 的目录、容器或 Docker 镜像。

## Release 资产

每个 `server-vX.Y.Z` Release 包含两个架构的以下文件：

- `moss-server-X.Y.Z-linux-ARCH.tar.gz`：宿主服务和内置 Node.js。
- `moss-runtime-X.Y.Z-linux-ARCH.tar.gz`：通过 `docker load` 加载的会话镜像。
- `moss-offline-X.Y.Z-linux-ARCH.tar.gz`：上述两项和安装器的离线组合包。
- `install.sh` 与 `SHA256SUMS`。

CI 先上传并验证 `moss/server/releases/server-vX.Y.Z/` 的不可变 COS 目录，再更新
GitHub Latest，最后覆盖 `moss/server/latest/install.sh` 固定入口。COS 上传需要仓库
Secrets `TENCENT_SECRET_ID` 和 `TENCENT_SECRET_KEY`。应用内部版本与部署通道版本
相互独立。
