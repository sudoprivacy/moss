# Moss Server 容器部署

本文说明仅部署 Moss/Nexus 控制面的入口。完整客户套件（含 SudoWork、PostgreSQL、Caddy）
使用配套 `sudostack` 仓库的 Helm 安装包，Moss 与 Nexus 各有独立 Deployment；
已验收的一键部署命令见 [主 README](../README.md#完整套件一键部署)。

一键安装将 Moss Server 与 Nexus 部署为 **k3s 中一个单副本 Pod 的两个独立容器**。
用户会话继续运行在独立的 scode/gVisor Pod 中。

| 组件 | 镜像 | 生命周期 |
| --- | --- | --- |
| Server、管理后台、API | `moss-server:<版本>-<架构>` | Kubernetes Deployment |
| Nexus、vault 插件、会话 exec 进程 | `moss-nexus:<版本>-<架构>` | 同一 Deployment 的独立容器 |
| scode 会话 | `my-moss-runtime:<版本>-<架构>` | 每个会话一个 Pod |

Server 镜像不含 Nexus；Nexus 镜像不含 Server、后台或模型文件。两个镜像均包含
`kubectl`：Server 创建会话 Pod，Nexus 负责执行 `kubectl exec` 并管理会话通道。
Moss 使用 `MOSS_NEXUS_MODE=external` 连接同 Pod 的 `127.0.0.1:2126`。
Nexus 使用 `serve-local`，不通过 Service、hostPort 或 Ingress 暴露。

Moss/Nexus 不创建业务 systemd 服务。k3s 本身仍由宿主机服务机制管理。

## Moss 控制面安装

要求 Linux amd64 或 arm64、root/sudo、Python 3.9+、curl、tar、gzip、flock。不要求宿主机 Node.js 或 Docker。
默认部署 k3s `v1.34.1+k3s1`，镜像内 kubectl 为 `v1.34.1`；更换集群版本时应保持受支持的客户端版本差距。

ARM64 使用 `aarch64`/`arm64` 自动识别；默认 gVisor 需要 4 KB 内存页（`getconf PAGE_SIZE` 为 `4096`）。企微会话存档 SDK 上游只提供 amd64 库，ARM64 镜像不包含该库。新发布流程同时构建两种架构；旧版本未发布的 ARM64 资产须等新 Release。

当前公网 `moss/server/latest/install.sh` 尚未切换到本仓库的新容器安装器。
以下命令要求已取得新安装器及配套版本资产；客户完整套件请使用主 README 中的候选包。

非交互安装：

```bash
sudo env MOSS_NON_INTERACTIVE=1 \
  MOSS_INSTALL_DIR=/data/moss \
  MOSS_ADVERTISED_HOST=10.0.1.206 \
  MOSS_ADMIN_USERNAME=admin \
  MOSS_ADMIN_PASSWORD='replace-with-a-strong-password' \
  ./install.sh
```

安装器会校验发布资产、导入三个镜像，并创建 Namespace、ServiceAccount、Role/RoleBinding、
Secret、PVC/PV、Service 和 Deployment。默认端口 `43127`，访问
`http://服务器IP:43127/admin/`。端口通过控制节点的 hostPort 提供；也可另外配置 Ingress。
`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_API_KEY` 可在首次安装时设置；API Key 启动后写入 vault。

| 参数 | 用途 |
| --- | --- |
| `--role all-in-one` | 默认；安装 k3s/gVisor 并部署 Server/Nexus |
| `--role control-plane` | 在本机已有的 k3s server 上部署 Server/Nexus |
| `--role compute` | 仅安装会话计算节点 |
| `--join URL --token TOKEN` | 计算节点加入种子集群 |
| `--install-dir PATH` | 指定数据和安装目录 |
| `--upgrade` | 获取最新版安装器并升级 |
| `--offline` | 仅使用脚本旁的离线资产 |
| `MOSS_CONTROL_NAMESPACE` | 控制命名空间，默认 `moss-control` |
| `MOSS_K8S_NAMESPACE` | 会话命名空间，默认 `moss-sessions`，须与控制命名空间不同 |
| `MOSS_CONTROL_NODE` | 控制节点的 `kubernetes.io/hostname` 标签；默认按本机 IP 识别 |
| `MOSS_K8S_RUNTIME_CLASS` | 默认 `gvisor`；已有集群可显式留空以使用默认运行时 |

首次运行 `--role control-plane` 时，计算节点的 runtime 镜像和 gVisor 须已准备好。
控制服务使用节点本地存储，固定在安装节点上。其他计算节点可运行会话；每次升级前须在各计算节点
导入对应版本的 Runtime 镜像（可运行同版本 `install.sh --role compute`）。镜像使用固定版本，
不依赖各节点的 `latest` 标签。会话计算节点需与所选 Runtime 镜像架构一致；本次不包含混合架构集群的自动调度。

## 数据与权限

```text
~/.moss/server/
  current -> releases/server-vX.Y.Z
  releases/          # 已生成的部署清单、配置和管理工具
  packages/          # 校验清单、镜像包、部署包
  backups/           # 停止写入后创建的升级快照；失败版本数据也保留在此
  data/              # SQLite、transcript、运行目录
  .moss/             # 用户设置、Skill、Assistant、Nexus/vault 数据
  server.json        # 持久配置；编辑后执行 restart.sh
  server-env.json    # 附加环境变量（JSON；不执行 shell）
  kubeconfig.json    # 使用 Pod 内投射的 ServiceAccount tokenFile
  k8s-install.json   # 已完成安装的版本、命名空间与节点
  install.sh
  start.sh / stop.sh / restart.sh / status.sh / logs.sh / uninstall.sh
```

控制数据用 `Retain` 策略的 local PV/PVC，两个容器挂到同一绝对路径，保留现有文件引用和 Nexus
工作目录。SQLite 和 vault 都只有一个写入实例。Deployment 使用 `Recreate`，不得手工增加副本。
会话工作区默认通过 k3s 的 `local-path` PVC 持久化；普通会话结束不会删除工作区。

集群权限只覆盖会话命名空间中的 Pod、exec、Secret、PVC。控制容器使用自动轮换的 ServiceAccount
令牌；用户会话 Pod 不挂载该令牌。配置和环境变量通过 Secret 注入，磁盘文件权限为 `600`。

## 启停、日志和升级

```bash
sudo ~/.moss/server/status.sh
sudo ~/.moss/server/stop.sh
sudo ~/.moss/server/start.sh
sudo ~/.moss/server/restart.sh
sudo ~/.moss/server/logs.sh server
sudo ~/.moss/server/logs.sh nexus
sudo ~/.moss/server/install.sh --upgrade
```

这些管理脚本操作 Kubernetes 资源，不调用业务 systemd 服务。升级先下载并校验所有资产、验证清单，
再停止旧 Pod，备份 `data/`、`.moss/` 与配置。新容器及 `/readyz` 正常后才提交新版本。
失败时先确认新写入进程已停止，再恢复原数据和原部署。若无法确认停止，不自动覆盖数据；保留快照供恢复。
同版本重复执行不会下载镜像或重启已存在的 Deployment。卸载后重复安装同版本会重新部署。

## 从旧进程安装迁移

对旧一键安装生成的 **embedded Nexus** 部署，运行新安装器并指定原安装目录即可。
迁移检查和镜像准备完成后才停止旧 `moss-server.service`，随后备份原数据并启动容器。
切换成功才禁用并移走旧业务 unit；启动失败恢复数据并重新启动原服务。旧 `moss-server.env` 会解析为数据，
不会当作 shell 执行。

以下情况在停止服务前拒绝自动迁移：独立 external Nexus/Co-host、自定义安装目录外的数据路径、
已经声明 `MOSS_NEXUS_ZONE_ID` 或存在 `data.zone-id.lock.json`。这些环境需要先明确服务、卷和证书的迁移关系。
备份应把整个 Nexus 目录作为一个单元，包含 `vault/master.key`、证书和 ZoneId 锁；不得只恢复数据而遗漏锁或密钥。

原进程安装器归档在 `deploy/legacy/install-host.sh`，仅用于旧版本回归与维护，不通过新一键入口发布。

## 离线交付

```bash
# 联网机器：下载三个镜像、部署工具及 k3s/gVisor 离线依赖
bash install.sh --download ./moss-offline
# 在其他架构的机器上预下载 ARM64 产物：
# MOSS_ARCH=arm64 bash install.sh --download ./moss-arm64

# 拷贝整个目录到目标机器
cd moss-offline
sudo ./install.sh --offline
```

离线目录包含 `install.sh`、`SHA256SUMS`、`moss-server-image-*`、`moss-nexus-image-*`、
`moss-runtime-*`、`moss-deploy-*` 及 `offline/` 基础设施资产。已有 k3s 环境无需重复准备基础设施，
仍须提供四个发布压缩包和校验清单。离线模式缺文件或校验失败会退出，不回退在线下载。
国内网络可使用 `K3S_MIRROR=cn bash install.sh --download ./moss-offline`；下载器校验
k3s 二进制和基础镜像，并兼容国内源的 `.tar.gz` 与上游的 `.tar.zst` 基础镜像包。

## 本地构建与发布

发布包中的镜像保留工具来自 `sudostack`。`deploy/k3s/sudostack-images.lock.json` 固定源提交和两个模块的 SHA256；构建会逐字节校验并连同来源清单放入部署包。节点离线安装时无需访问源仓库。Server、Nexus 和 Runtime 镜像只有在 CRI 返回预期身份且已固定后，安装才继续；`IMPORT_RUNTIME_IMAGE=0` 允许完整套件自行负责工作镜像。

Runtime 发布清单使用离线归档中经过摘要校验的 OCI manifest/index 身份（`image.digestKind: oci-manifest`），用于匹配 Kubernetes 报告的 manifest/index 摘要。Docker config 摘要仍用于核对保存的归档与刚构建的镜像，以及节点导入、固定校验；两种摘要不能直接比较。

本地构建先准备该锁定版本的工具源码：

```bash
git clone --filter=blob:none --no-checkout https://github.com/sudoprivacy/sudostack.git .moss-image-tools
git -C .moss-image-tools sparse-checkout set --no-cone /tools/deploy/images.py /tools/deploy/artifacts.py
git -C .moss-image-tools checkout "$(python3 -c 'import json; print(json.load(open("deploy/k3s/sudostack-images.lock.json"))["revision"])')"
```

```bash
bash deploy/package-control-images.sh <版本号> arm64 ./dist
```

也可设置 `MOSS_SHARED_IMAGE_SOURCE` 指向已有的对应源码目录。CI 自动读取同一份锁定清单并检出源码；这些构建依赖不进入业务镜像。

架构参数支持 `amd64` 和 `arm64`；原生 CI runner 分别执行安装和会话验收。该命令构建独立的 Server/Nexus 镜像并导出镜像包和部署工具包。完整发行还需要现有的 Runtime
构建步骤和带版本号的安装器。`build-release.yml` 在发布资产前执行镜像检查、安装/会话/重启/离线重装
测试；COS/GitHub Release 同步包含新镜像。每种架构还发布 `runtime-release-<arch>.json`，绑定镜像、CLI/cohost 版本和摘要；`runtime-release.json` 保留为 amd64 别名。完成发布后 `latest/install.sh` 才切换到新安装入口。
带 SemVer 预发布后缀的 `server-v*` tag 同样经过完整测试并上传固定 COS 版本目录，但标记为 GitHub prerelease，且不更新现有 `latest` 入口。
构建会话 Runtime 时可通过 `--build-arg HF_ENDPOINT=https://hf-mirror.com --build-arg HF_HUB_DISABLE_XET=1` 指定模型镜像源，
通过 `--build-arg SCODE_DOWNLOAD_URL=<地址>` 指定 scode 下载地址；scode 仍按仓库固定 SHA256 校验。

`server.Dockerfile.local` 的 npm 原生依赖下载使用按目标架构隔离的 BuildKit 缓存
`moss-native-amd64` / `moss-native-arm64`，用于镜像构建失败后重试。缓存挂载在
构建阶段的 `/root/.npm`，不进入最终镜像。Bun 下载同样保存在按架构隔离的
`moss-bun-*` 缓存中，避免原生安装失败后重新拉取整个依赖集合。
Sharp 仍按安装包内的 SHA512 校验
`_libvips` 中的缓存归档；网络受限时可通过可信下载渠道预热经过该摘要校验的
同版本、同架构文件。不要使用跳过完整性检查的安装选项。缓存不能替代锁定源码、
候选镜像摘要或实际启动验收。

## 卸载

```bash
sudo ~/.moss/server/uninstall.sh          # 移除业务工作负载，保留 PVC 和数据
sudo ~/.moss/server/uninstall.sh --purge  # 同时删除本安装及会话工作区数据
```

卸载不删除 k3s，也不删除命名空间中的其他工作负载。local PV 不提供跨节点数据复制；控制节点磁盘故障恢复
依赖备份，多副本与跨节点高可用不属于本安装形态。

### 完整套件的 Helm 入口

`sudostack/tools/deploy/package.py` 消费这里生成的三个镜像及 `bootstrap-nexus.mjs`，增加 SudoWork、PostgreSQL、Caddy 和 Helm Chart。`bootstrap-nexus.ts` 使用随 Nexus 客户端发布的官方 proto，为 Moss 签发专用 Agent 证书并登记会话签发权限；单节点 profile 不注入多实例路由参数。候选包的一键入口为 `install-atlas.sh --host HOST --manage-k3s`。
