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

## k3s（gvisor 隔离运行时）安装

默认运行时是 Docker。若希望每个会话运行在 gvisor 沙箱 Pod 中，先在**计算节点**
上一键部署 k3s + gvisor + moss-runtime 镜像（与 Server 同一发布版本）：

```bash
curl -fL --progress-bar https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install-k3s.sh | sudo bash
```

脚本会提示节点 IP、命名空间等必要参数（`--non-interactive` 全部取默认值），完成后
在 moss server.json 旁写出 `moss-k3s-kubeconfig.yaml`，并打印如何让 moss-server 切到
k8s 的说明。

离线安装：在有网络的机器运行 `fetch-offline-deps.sh` 生成 `./offline`，连同 `deploy/k3s`
目录拷到节点后执行 `sudo OFFLINE_MODE=on ./install-k3s.sh`。

部署完成后让 moss-server 使用 k8s，二选一：

- **全新安装**：运行 Server 安装脚本，在“Session runtime”提示处选择 `k8s`（自动写入
  `k8s` 配置块）。
- **已安装**：编辑 `~/.moss/server/server.json`，将 `runtimeDefaults.type` 改为 `"k8s"`，
  重启 moss-server。

### 接入已有的 k8s 集群

若客户已有 k8s 集群，无需运行 `install-k3s.sh`，只需在 `server.json` 的 `k8s` 块里
指向他们的 kubeconfig。moss-server 通过本机 `kubectl` + kubeconfig 操作集群，前提是
集群满足：

- `runtimeClassName`：默认 `gvisor`。集群若无 gvisor RuntimeClass，设为 `""`（留空）即
  省略该字段，Pod 使用集群默认运行时。
- 镜像：`image` 需在集群各节点可拉取；私有仓库用 `imagePullSecrets`（预先创建的
  dockerconfigjson Secret 名），`imagePullPolicy` 默认 `IfNotPresent`。
- 命名空间：不存在时 moss 会自动创建（需 kubeconfig 具备相应权限）。

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
