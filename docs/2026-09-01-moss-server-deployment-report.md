# Moss Server 一键部署与发布成果汇报

日期：2026-09-01<br>
当前正式版本：`server-v0.1.7`<br>
支持平台：Linux x86_64/amd64<br>
完成状态：代码已合并、Release 已发布、腾讯云 COS 已同步

## 一、今日成果概览

今日完成了 Moss Server 从构建、发布、在线安装、离线安装到升级、卸载和回滚的完整
交付链路，主要成果如下：

1. 完成 Server-only 发布，不再包含桌面端产物。
2. Server 包包含编译后的 `moss-server.mjs`、Node.js 22 和运行依赖，无需服务器预装 Node.js。
3. Runtime 以 Docker 镜像包交付，安装时自动校验并执行 `docker load`。
4. `nexusd-cluster` 使用 `nexi-lab/nexus` 官方 Release，不在 Moss CI 中编译 nexusd。
5. 支持国内 COS、国外 GitHub Release 和完全离线三种安装方式。
6. 安装目录默认跟随发起安装的用户，不固定为 root。
7. 密码和 API Key 输入显示 `*`，非空输入要求二次确认。
8. 增加对外服务地址配置，默认取本机 IP，可修改为公网 IP 或域名。
9. 在线安装后保留原始 Server 包、Runtime 镜像包、安装脚本和校验文件。
10. 支持程序升级、同版本跳过、配置与数据保护、健康检查和失败回滚。
11. 建立 Tag 驱动的 Release CI，自动发布 GitHub Release 和腾讯云 COS 全球加速地址。
12. 在 `10.0.1.206` 完成全新安装和重复安装测试。

## 二、交付内容

| 交付项 | 结果 |
| --- | --- |
| 一键安装脚本 | `install.sh` |
| Server 程序包 | `moss-server-0.1.7-linux-amd64.tar.gz` |
| Runtime 镜像包 | `moss-runtime-0.1.7-linux-amd64.tar.gz` |
| 完整性校验 | `SHA256SUMS` |
| 国内分发 | 腾讯云 COS 全球加速 |
| 国外分发 | GitHub Release |
| 离线交付 | 一个安装脚本、两个压缩包、一个校验文件 |
| 服务管理 | systemd + 安装目录内启停脚本 |
| 数据目录 | 安装用户的 `~/.moss/server/data/` |

## 三、环境要求

- Linux x86_64/amd64
- glibc 2.35 或更高版本，推荐 Ubuntu 22.04 或更新版本
- systemd
- Docker 20.10 或更高版本
- root 或 sudo 权限
- `curl`、`tar`、`gzip`、`sha256sum`、`stty`

不需要安装 Node.js 或 Docker Compose。

## 四、在线安装

### 4.1 国内安装

使用腾讯云 COS 全球加速固定地址：

```bash
curl -fL --progress-bar \
  https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh \
  | sudo bash
```

### 4.2 国外安装

使用 GitHub Latest Release：

```bash
BASE=https://github.com/sudoprivacy/moss/releases/latest/download
curl -fL --progress-bar "$BASE/install.sh" \
  | sudo env MOSS_DOWNLOAD_BASE="$BASE" bash
```

### 4.3 默认安装目录

默认目录是发起安装用户的：

```text
~/.moss/server
```

- 普通用户执行 `sudo` 安装时，默认使用该普通用户的 Home 目录。
- 直接以 root 登录并安装时，默认使用 `/root/.moss/server`。
- 安装时可以输入其他绝对路径。
- systemd 服务以安装用户身份运行。

## 五、安装交互参数

| 安装提示 | 默认值 | 作用 |
| --- | --- | --- |
| `Install directory` | `<安装用户 HOME>/.moss/server` | 程序、配置、数据和缓存根目录 |
| `Service port` | `43127` | Moss Server 监听端口 |
| `Public server address (IP or hostname)` | 本机第一个 IP | 对外访问 IP 或域名 |
| `Administrator username` | `admin` | 初始管理员用户名 |
| `Administrator password` | 留空自动生成 | 初始管理员密码，显示 `*` 并确认两次 |
| `Anthropic API Base URL` | `https://hk.sudorouter.ai/v1` | Anthropic 兼容接口地址 |
| `Anthropic API Key` | 可留空 | API Key，显示 `*`，非空时确认两次 |

管理员密码留空时由安装器生成随机密码，并在安装成功信息中显示一次，部署人员需要及时
记录。文档和日志汇报中不应记录真实管理员密码或 API Key。

对外服务地址写入：

```text
server.advertisedHost
server.publicBaseUrl
```

例如输入 `10.0.1.206`、端口使用 `43127` 时：

```text
advertisedHost = 10.0.1.206
publicBaseUrl = http://10.0.1.206:43127
```

安装完成后的管理后台地址：

```text
http://<对外服务地址>:43127/admin/
```

## 六、非交互安装与环境变量

自动化部署示例：

```bash
curl -fL --progress-bar \
  https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh \
  | sudo env \
      MOSS_NON_INTERACTIVE=1 \
      MOSS_INSTALL_DIR=/data/moss \
      MOSS_PORT=43127 \
      MOSS_ADVERTISED_HOST=moss.example.com \
      MOSS_ADMIN_USERNAME=admin \
      MOSS_ADMIN_PASSWORD='replace-with-a-strong-password' \
      ANTHROPIC_BASE_URL=https://hk.sudorouter.ai/v1 \
      ANTHROPIC_API_KEY='replace-with-api-key' \
      bash
```

| 环境变量 | 说明 |
| --- | --- |
| `MOSS_NON_INTERACTIVE=1` | 禁用交互，使用环境变量或默认值 |
| `MOSS_INSTALL_USER` | 指定服务运行用户 |
| `MOSS_INSTALL_DIR` | 指定安装根目录 |
| `MOSS_PORT` | 指定监听端口 |
| `MOSS_ADVERTISED_HOST` | 指定公网 IP、内网 IP 或域名 |
| `MOSS_ADMIN_USERNAME` | 指定初始管理员用户名 |
| `MOSS_ADMIN_PASSWORD` | 指定初始管理员密码 |
| `ANTHROPIC_BASE_URL` | 指定 Anthropic API Base URL |
| `ANTHROPIC_API_KEY` | 指定 Anthropic API Key |
| `MOSS_DOWNLOAD_BASE` | 指定 Server、Runtime 和校验文件下载源 |
| `MOSS_INSTALLER_URL` | 指定在线升级时的 Latest 安装脚本地址 |

安装脚本命令行参数：

| 参数 | 说明 |
| --- | --- |
| `--offline` | 从当前脚本目录读取离线资产，不访问网络 |
| `--download PATH` | 只下载完整离线资产到指定目录，不执行安装 |
| `--upgrade` | 升级已有安装，不重新配置用户数据 |
| `--install-dir PATH` | 指定安装目录，必须是无空格的绝对路径 |
| `--non-interactive` | 使用环境变量或默认值，不显示交互提示 |
| `-h`、`--help` | 查看帮助 |

直接指定安装目录示例：

```bash
sudo ./install.sh --install-dir /data/moss
```

## 七、离线安装

### 7.1 准备离线目录

在可联网机器执行纯下载模式：

```bash
curl -fL --progress-bar \
  https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh \
  | bash -s -- --download ./moss-offline
```

生成目录包含：

```text
moss-offline/
  install.sh
  SHA256SUMS
  moss-server-0.1.7-linux-amd64.tar.gz
  moss-runtime-0.1.7-linux-amd64.tar.gz
```

### 7.2 在离线服务器安装

```bash
cd moss-offline
sudo ./install.sh --offline
```

离线安装不会访问网络，Server 包和 Runtime 镜像包均通过 SHA-256 校验。

## 八、升级逻辑

### 8.1 在线升级到最新版

安装目录内的脚本是长期升级入口：

```bash
sudo ~/.moss/server/install.sh --upgrade
```

其流程为：

1. 从固定 `latest/install.sh` 获取小型最新版安装脚本。
2. 比较目标版本与当前 `current` 版本。
3. 版本相同则退出，不下载 Server/Runtime 包，也不重启服务。
4. 版本变化时下载并校验新包，加载新 Runtime 镜像。
5. 切换 Server 版本目录并执行健康检查。
6. 启动或健康检查失败时恢复上一版程序和配置。

### 8.2 固定版本脚本

从具体 Release 下载或保存在 `/root/install.sh` 的脚本已经固定目标版本。例如脚本目标
为 `server-v0.1.7`，当前也已安装 `server-v0.1.7` 时：

```bash
./install.sh
./install.sh --upgrade
```

两条命令都会在联网前直接退出，不产生任何下载。

固定版本脚本不能发现未来版本；发现和安装后续版本应使用安装目录内的升级入口。

### 8.3 国外升级

```bash
BASE=https://github.com/sudoprivacy/moss/releases/latest/download
sudo env MOSS_INSTALLER_URL="$BASE/install.sh" MOSS_DOWNLOAD_BASE="$BASE" \
  ~/.moss/server/install.sh --upgrade
```

### 8.4 离线升级

使用新版本离线目录：

```bash
cd moss-offline
sudo ./install.sh --offline --upgrade
```

### 8.5 升级保护范围

升级只替换 Server 版本目录、Runtime 镜像和内部 Runtime 镜像引用，不重新询问或覆盖：

- `data/` 运行数据
- 管理员账号和密码
- Anthropic Base URL 和 API Key
- 其他用户配置

## 九、安装目录规划

```text
~/.moss/server/
  current -> releases/server-vX.Y.Z
  releases/          # Server、Node.js 和运行依赖
  packages/          # 按版本保留安装脚本、校验文件和两个原始包
  data/              # SQLite、transcript 和 session 数据
  .moss/             # 设置、Skill、Assistant 和 Nexus 数据
  server.json        # Server 主配置
  moss-server.env    # systemd 环境变量
  install.sh         # 安装与升级脚本
  start.sh
  stop.sh
  status.sh
  uninstall.sh
```

在线安装的原始包保留在：

```text
~/.moss/server/packages/server-vX.Y.Z/
```

保留内容包括 `install.sh`、`SHA256SUMS`、Server 压缩包和 Runtime 镜像压缩包。
完整且校验通过的缓存包可在安装重试时复用。

配置文件 `server.json`、`moss-server.env` 和 `.moss/settings.json` 权限为 `600`。

## 十、服务管理命令

### 10.1 systemd 命令

```bash
sudo systemctl status moss-server
sudo systemctl start moss-server
sudo systemctl stop moss-server
sudo systemctl restart moss-server
sudo journalctl -u moss-server.service -f
```

### 10.2 安装目录脚本

```bash
sudo ~/.moss/server/status.sh
sudo ~/.moss/server/start.sh
sudo ~/.moss/server/stop.sh
```

### 10.3 健康检查

```bash
curl http://127.0.0.1:43127/healthz
```

健康响应示例：

```json
{"ok":true,"ready":true,"sessions":0,"auth_mode":"local"}
```

## 十一、卸载命令

保留配置、数据、安装包缓存：

```bash
sudo ~/.moss/server/uninstall.sh
```

删除程序、配置、数据和安装包缓存：

```bash
sudo ~/.moss/server/uninstall.sh --purge
```

## 十二、Release 与 CI 结果

### 12.1 合并记录

| PR | 内容 | Merge commit |
| --- | --- | --- |
| [#188](https://github.com/sudoprivacy/moss/pull/188) | 完善安装交互、升级、包缓存和文档 | `8fd60ce` |
| [#189](https://github.com/sudoprivacy/moss/pull/189) | 固定版本脚本同版本时零联网退出 | `e12f3ef` |

### 12.2 正式版本

- Tag：`server-v0.1.7`
- GitHub Release：<https://github.com/sudoprivacy/moss/releases/tag/server-v0.1.7>
- Release CI：<https://github.com/sudoprivacy/moss/actions/runs/33493504322>
- CI 结果：`success`

### 12.3 Release 资产

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `install.sh` | 29,215 B | `e53a5b6d0dc296e05c3a422860daa21f7a67c333da0736d45bab73f0dc53b82b` |
| `moss-server-0.1.7-linux-amd64.tar.gz` | 243,065,756 B | `da9eeaa0658e916405583bd56c0030b6f3030e9d0c747760c0309ff0ad063243` |
| `moss-runtime-0.1.7-linux-amd64.tar.gz` | 159,204,162 B | `fd7eb7b28d0052eb692ae5f506f2fc851cd377e9bc9396918049a62ee212dec8` |
| `SHA256SUMS` | 207 B | `18cc8d089f7bd7a4a206b0a7e079077ecf52b958effd37a554dec7a27ff236e6` |

### 12.4 发布链路

Tag 推送后，CI 自动执行：

1. 校验部署脚本和 Release 元数据。
2. 构建包含 Node.js 22 的 amd64 Server 包。
3. 构建并冒烟测试 amd64 Runtime Docker 镜像。
4. 组装版本化 `install.sh` 和 `SHA256SUMS`。
5. 校验 Server 包必须包含 `moss-server.mjs` 和 Node.js。
6. 上传腾讯云 COS immutable 版本目录并通过全球加速地址校验。
7. 创建 GitHub Release 并上传四个资产。
8. 更新并校验 COS 固定 `latest/install.sh`。

### 12.5 固定分发地址

国内固定安装地址：

```text
https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/latest/install.sh
```

COS 版本目录：

```text
https://sudowork-release-1309794936.cos.accelerate.myqcloud.com/moss/server/releases/server-v0.1.7/
```

GitHub Latest：

```text
https://github.com/sudoprivacy/moss/releases/latest/download/install.sh
```

发布后已独立验证 COS 和 GitHub Latest 均返回 `server-v0.1.7` 安装脚本。

## 十三、10.0.1.206 实测结果

在 Ubuntu 测试机 `10.0.1.206` 完成以下验证：

1. 清除旧服务、安装目录、数据目录、Runtime 镜像和 Docker 网络后全新安装。
2. 安装目录默认识别为 `/root/.moss/server`。
3. 端口提示默认值为 `43127`。
4. 对外地址提示默认识别为 `10.0.1.206`，并可手动修改。
5. 管理员密码和非空 API Key 均显示星号并完成二次确认。
6. `advertisedHost`、`publicBaseUrl` 和端口配置写入正确。
7. systemd 服务启动成功，健康检查通过。
8. Server 和 Runtime 原始包保留在版本化缓存目录，合计约 384 MB。
9. 两个压缩包执行 SHA-256 校验通过。
10. 重复执行普通安装时，同版本无下载、无镜像加载、无服务重启。
11. 同版本升级时，服务 PID、Server 配置和 Anthropic 配置保持不变。
12. 使用不可访问的测试 URL 验证固定版本脚本可在联网前正确退出。

截至文档生成时，测试机仍运行 `server-v0.1.6`，服务状态为 active；正式
`server-v0.1.7` 已发布，可使用以下命令验证正式升级：

```bash
/root/.moss/server/install.sh --upgrade
```

## 十四、汇报结论

Moss Server 已形成可复用的标准交付能力：

- 用户可通过一条命令完成国内或国外在线安装。
- 可通过纯下载模式准备完整离线目录。
- 安装过程具备环境校验、进度展示、敏感输入保护、包校验和健康检查。
- 安装目录、配置、数据、版本程序和原始包职责清晰。
- 升级过程保护用户数据和业务配置，同版本不会重复下载大包或重启服务。
- Release CI 可由 `server-vX.Y.Z` Tag 自动完成构建、测试、GitHub 发布和 COS 同步。
- `server-v0.1.7` 已完成正式发布，固定安装地址已生效。

今日目标已全部完成并形成文档、脚本、CI、Release 和实机验证闭环。
