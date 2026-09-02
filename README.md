# Moss Server

Moss Server 是多用户 AI coding agent 服务。Server 在 Linux 宿主机运行，用户会话
运行在 Docker Runtime 中。

## 环境要求

- Linux x86_64/amd64，glibc 2.39+（推荐 Ubuntu 24.04+）
- systemd、Docker 20.10+
- root/sudo 权限
- `curl`、`tar`、`gzip`、`sha256sum`

安装包已包含 Node.js 22、`moss-server.mjs`、host 模式 `scode`、运行依赖和 Nexus；
Runtime 镜像也包含 Docker 模式 `scode`，无需安装 Node.js 或 Docker Compose。

## 在线安装

国内（腾讯云 COS）：

```bash
curl -fL --progress-bar https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh | sudo bash
```

国外（GitHub Release）：

```bash
BASE=https://github.com/sudoprivacy/moss/releases/latest/download
curl -fL --progress-bar "$BASE/install.sh" | sudo env MOSS_DOWNLOAD_BASE="$BASE" bash
```

安装器会提示安装目录、服务器地址和管理员账号。默认安装到当前用户的
`~/.moss/server`，默认端口 `43127`。安装完成后访问：

```text
http://服务器IP:43127/admin/
```

## 离线安装

在有网络的机器准备离线目录：

```bash
curl -fL --progress-bar https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh \
  | bash -s -- --download ./moss-offline
```

将生成的 `moss-offline` 目录传到服务器后执行：

```bash
cd moss-offline
sudo ./install.sh --offline
```

目录内包含安装脚本、Server 包、Docker Runtime 镜像包和校验文件。离线安装过程
不访问网络。

## 服务管理

```bash
sudo systemctl status moss-server
sudo systemctl start moss-server
sudo systemctl restart moss-server
sudo systemctl stop moss-server
sudo journalctl -u moss-server -f
curl http://127.0.0.1:43127/healthz
```

## 升级与卸载

```bash
# 从固定 COS 地址升级到最新版
sudo ~/.moss/server/install.sh --upgrade

# 卸载程序，保留配置和数据
sudo ~/.moss/server/uninstall.sh

# 删除程序、配置和数据
sudo ~/.moss/server/uninstall.sh --purge
```

升级不需要重新配置，只替换 Server 程序和 Runtime 镜像；管理员、API 配置和运行
数据保持不变，启动失败会自动回滚。安装目录内的升级脚本只获取小型最新版脚本确认
版本，同版本不下载 Server 包和 Runtime 镜像，也不重启服务。

在线安装的原始包保留在 `~/.moss/server/packages/server-vX.Y.Z/`。重复执行同版本
的外部 `install.sh`（包括 `--upgrade`）会直接退出，不联网、不重启服务。

更多参数和目录说明见 [部署文档](deploy/README.md)，接口见
[Moss Server API](src/server/API.md)。
