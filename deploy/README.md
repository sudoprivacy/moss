# Moss Server 部署

## 环境要求

- Linux x86_64/amd64，glibc 2.35+（推荐 Ubuntu 22.04+）
- systemd、Docker 20.10+
- root/sudo 权限
- `curl`、`tar`、`gzip`、`sha256sum`

安装包自带 Node.js 22、编译后的 `moss-server.mjs`、运行依赖和官方
`nexusd-cluster`，无需系统 Node.js 或 Docker Compose。

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
  releases/          # Server、Node.js 和运行依赖
  data/              # SQLite、transcript 和 session 数据
  .moss/             # 设置、Skill、Assistant 和 Nexus 数据
  server.json        # 主配置
  moss-server.env    # systemd 环境变量
  start.sh
  stop.sh
  status.sh
  uninstall.sh
```

`server.json`、`moss-server.env` 和 `.moss/settings.json` 权限为 `600`。修改配置后
重启服务生效。

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

再次执行在线安装命令即可升级；配置和数据会保留，启动失败时自动回滚。

```bash
# 保留配置和数据
sudo ~/.moss/server/uninstall.sh

# 删除程序、配置和数据
sudo ~/.moss/server/uninstall.sh --purge
```

每个 Release 提供 amd64 Server 包、Runtime 镜像包、`install.sh` 和
`SHA256SUMS`。
