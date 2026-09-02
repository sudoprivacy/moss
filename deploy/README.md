# Moss Server 部署

## 环境要求

- Linux x86_64/amd64，glibc 2.35+（Ubuntu 22.04+）
- systemd、Docker 20.10+
- root/sudo 权限
- `curl`、`tar`、`gzip`、`sha256sum`

安装包自带 Node.js 22、编译后的 `moss-server.mjs`、host 模式 `scode`、运行依赖
和官方 `nexusd-cluster`；Runtime 镜像包含 Docker 模式 `scode`，无需系统 Node.js
或 Docker Compose。

Runtime 镜像基于 Ubuntu 24.04。Ubuntu 22.04 宿主机可以使用 Docker 会话；
host 会话直接执行安装包内的 scode，需要 glibc 2.39+（Ubuntu 24.04+）。安装器会在
glibc 2.35–2.38 上自动禁用 host 会话，不影响默认的 Docker 会话。

host 会话使用 `current/app/bin/scode`，Docker 会话使用容器内
`/usr/local/bin/scode`，对应 `runtimeDefaults.hostScodePath` 和
`runtimeDefaults.dockerScodePath`；`runtimeDefaults.hostScodeEnabled` 表示宿主机
是否满足 host scode 的运行条件。两者统一读取
`src/server/nexus/runtime-versions.json` 中的 `scode` 版本；升级时只修改这一处。

## 在线安装

国内：

```bash
curl -fL --progress-bar https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh | sudo bash
```

国外：

```bash
BASE=https://github.com/sudoprivacy/moss/releases/latest/download
curl -fL --progress-bar "$BASE/install.sh" | sudo env MOSS_DOWNLOAD_BASE="$BASE" bash
```

默认安装目录是发起安装用户的 `$HOME/.moss/server`，服务也以该用户运行；直接
使用 root 安装时才会使用 `/root/.moss/server`。默认端口为 `43127`。

非交互或自定义安装：

```bash
curl -fL --progress-bar https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh \
  | sudo env MOSS_NON_INTERACTIVE=1 \
      MOSS_INSTALL_DIR=/data/moss \
      MOSS_PORT=43127 \
      MOSS_ADVERTISED_HOST=10.0.1.206 \
      MOSS_ADMIN_USERNAME=admin \
      MOSS_ADMIN_PASSWORD='replace-with-a-strong-password' \
      bash
```

还可设置 `MOSS_INSTALL_USER`、`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY`。

## 离线安装

在有网络的机器执行：

```bash
curl -fL --progress-bar https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh \
  | bash -s -- --download ./moss-offline
```

将生成的 `moss-offline` 目录传到离线服务器后执行：

```bash
cd moss-offline
sudo ./install.sh --offline
```

目录内包含 `install.sh`、Server 包、Docker Runtime 镜像包和 `SHA256SUMS`。

## 目录与配置

```text
~/.moss/server/
  current -> releases/server-vX.Y.Z
  releases/          # Server、Node.js、host scode 和运行依赖
  packages/          # 按版本保留安装脚本、校验文件和两个原始压缩包
  data/              # SQLite、transcript 和 session 数据
  .moss/             # 设置、Skill、Assistant 和 Nexus 数据
  server.json        # 主配置
  moss-server.env    # systemd 环境变量
  install.sh         # 安装与升级脚本
  start.sh
  stop.sh
  status.sh
  uninstall.sh
```

`server.json`、`moss-server.env` 和 `.moss/settings.json` 权限为 `600`。修改配置后
重启服务生效。在线安装包保留在 `packages/server-vX.Y.Z/`，重复执行同版本安装时
直接退出，不重新下载，也不重启服务。

## 常用操作

```bash
sudo ~/.moss/server/status.sh
sudo ~/.moss/server/stop.sh
sudo ~/.moss/server/start.sh
sudo systemctl restart moss-server
sudo journalctl -u moss-server -f
curl http://127.0.0.1:43127/healthz
```

管理后台：`http://服务器IP:43127/admin/`

## 升级与卸载

在线升级默认使用固定 COS 地址：

```bash
sudo ~/.moss/server/install.sh --upgrade
```

国外可使用 GitHub Release：

```bash
BASE=https://github.com/sudoprivacy/moss/releases/latest/download
sudo env MOSS_INSTALLER_URL="$BASE/install.sh" MOSS_DOWNLOAD_BASE="$BASE" \
  ~/.moss/server/install.sh --upgrade
```

离线升级使用新版本离线目录，不访问网络：

```bash
cd moss-offline
sudo ./install.sh --offline --upgrade
```

升级无需重新输入配置，只替换 Server 版本目录、Runtime 镜像及其内部镜像引用；
`data/`、管理员信息、Anthropic 配置和其他用户配置保持不变。启动或健康检查失败
会自动恢复上一版程序和配置。同版本仅获取小安装脚本确认版本，不下载 Server 包和
Runtime 镜像，也不重启服务。

固定版本脚本（例如 `/root/install.sh`）已经知道目标版本；目标版本与当前版本相同时，
普通安装和 `--upgrade` 都会在联网前直接退出。安装目录内的
`~/.moss/server/install.sh --upgrade` 是长期升级入口，会从 `latest` 获取小安装脚本
以发现后续版本。

卸载：

```bash
# 保留配置和数据
sudo ~/.moss/server/uninstall.sh

# 删除程序、配置和数据
sudo ~/.moss/server/uninstall.sh --purge
```

每个 Release 提供 amd64 Server 包、Runtime 镜像包、`install.sh` 和
`SHA256SUMS`。
