# Moss Server

Moss Server 是多用户 AI coding agent 服务。完整客户套件包含 Moss Server、Nexus、Sudocode 和 SudoWork，
由配套 `sudostack` 仓库统一装配，使用 Caddy 提供 HTTPS 入口。
Moss Server 与 Nexus 使用独立镜像、独立 Kubernetes Deployment；Sudocode 会话按需运行在 gVisor Pod 中。
业务服务由 k3s 管理，宿主机 systemd 只管理 k3s 基础设施。

## 完整套件一键部署

**单节点 k3s 一键部署已在 `10.0.1.180` 验证可用。** 当前交付版本为
`atlas-mvp-0.1.0-k3s.20261012`，完整包约 3.2 GiB。
这是内部候选包；公网 `moss/server/latest/install.sh` 尚未更新，不能用它安装本套件。

目标机要求 Linux amd64、root/sudo、Python 3.9+、curl、tar、gzip、flock、openssl 和 sha256sum，
预留 80、443、8443 端口。当前已验证 Ubuntu 22.04.4。
完整包包含镜像、k3s、gVisor、Helm 和安装工具，客户机无需安装 Docker 或 Node.js。

内部环境可从验收机取得安装包与校验文件，再一起交付到客户服务器：

```bash
scp root@10.0.1.180:/root/atlas-mvp-0.1.0-k3s.20261012-amd64.tar .
scp root@10.0.1.180:/root/atlas-mvp-0.1.0-k3s.20261012-amd64.tar.sha256 .
```

在客户服务器上校验、解包，然后执行安装。将 `ATLAS_HOST` 改为客户服务器的 IPv4 地址或已解析到该机的域名：

```bash
sha256sum -c atlas-mvp-0.1.0-k3s.20261012-amd64.tar.sha256
mkdir -p atlas-k3s
tar -xf atlas-mvp-0.1.0-k3s.20261012-amd64.tar -C atlas-k3s
cd atlas-k3s
ATLAS_HOST=10.0.1.180
sudo bash install-atlas.sh --host "$ATLAS_HOST" --root /data/atlas --manage-k3s
```

确认校验结果为 `OK` 后再解包。包的 SHA256 为：

```text
d771e95c683b0107424051ac95447a66b8298ab86421b514bc4f98ebf9b8fabf
```

`--manage-k3s` 允许安装器安装或重启 k3s，并关闭内置 Traefik，让 Caddy 使用上述端口。
必须使用完整安装包；仅复制源码中的 `install-atlas.sh` 无法安装。

## 访问与首次配置

| 用途 | 地址或位置（将 `<host>` 替换为安装时的地址） |
| --- | --- |
| SudoWork | `https://<host>`，登录页选择“密码登录” |
| Moss 管理后台 | `https://<host>:8443/admin/` |
| 初始管理员账号和随机密码 | 目标机 `/data/atlas/admin-credentials.txt`，仅 root 可读 |
| 默认测试 CA | 目标机 `/data/atlas/tls/ca.crt`，导入访问端的受信任证书库 |

Caddy 统一承接入口；两套应用都使用 `/api/v1`，因此分别使用 443 和 8443。
默认生成 90 天测试证书。使用客户证书时，在首次安装命令中同时增加
`--tls-cert /secure/fullchain.pem --tls-key /secure/key.pem --tls-ca /secure/ca-chain.pem`。

安装器自动验证 HTTPS、WebUI 登录、WebSocket、gVisor 会话和历史记录，验收使用临时模拟模型。
**真实模型任务需要管理员在 Moss 系统设置中配置客户的 Router 地址和 API Key。**

## 日常管理

```bash
sudo /data/atlas/status.sh
sudo /data/atlas/verify.sh
sudo /data/atlas/start.sh
sudo /data/atlas/stop.sh
sudo /data/atlas/restart.sh
sudo k3s kubectl -n atlas-system logs deployment/moss-server
sudo k3s kubectl -n atlas-system logs deployment/nexus-broker
```

业务数据保存在 PVC 中。相同安装包、相同参数重复执行只验证现有安装，不重启 Pod。
当前候选拒绝不同版本直接覆盖升级。加密冷备份和本机恢复使用 `/data/atlas/backup.sh`、
`/data/atlas/restore.sh`，密钥准备和完整命令见配套 `sudostack` 仓库的 `docs/deployment/private-k3s.md`。

本次已验证登录、模拟模型对话、重启后续聊、加密备份恢复和重复安装。
Ubuntu 24.04 空机验收、正式制品签名、跨版本升级失败回滚和跨集群恢复尚未完成；
验收记录见 `sudostack/docs/deployment/10.0.1.180-acceptance.md`。

## Moss 控制面单独部署与开发

本仓库 `deploy/install.sh` 用于仅部署 Moss/Nexus 的场景，二者在同一 Pod 的独立容器中运行，
与上述完整套件的独立 Deployment 拓扑不同。使用该入口需要配套版本的发布资产。
镜像构建、持久化、旧进程迁移和发布说明见 [Moss 控制面部署文档](deploy/README.md)，
接口见 [Moss Server API](src/server/API.md)。
