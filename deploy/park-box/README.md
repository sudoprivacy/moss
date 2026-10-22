# 园区运维盒子 Docker 交付

用户明确要求：完整实现原始方案 10.3 及 P0、P1 涉及的盒子运维能力，每项能力必须实际可用并经过验证；交付全部使用 Docker，Docker Compose 是唯一部署入口；高内聚、低耦合、最小程度修改已有代码；聚焦需求，不进行顺手修改；原因、方案与验收结果必须有事实依据，不把模拟执行、HTTP 200 或程序退出成功当作功能验收。计划文档仅在用户明确授权后编写。

## 部署入口

在本目录执行 `node boxctl.mjs keys` 生成升级签名密钥，将 `setup.example.json` 复制到被 Git 忽略的 `configuration/setup.json`，填写管理员、领导与招商运营账号、组织模型提供方、园区内容和至少四个快捷问题，将实际政策文件放在 `configuration/policies/`。

执行 `node boxctl.mjs build 1` 构建运维、Nexus、Moss 和 Park 镜像，然后执行 `node boxctl.mjs install 1`。安装通过容器内既有业务 API 绑定 organization、设置园区角色和模型、导入政策、构建知识库、发布 Assistant、创建快捷问题与渠道入口。最终验证任务通过真实公开咨询接口检查流式回答、咨询记录和可打开的政策引用；失败会使安装命令失败。`node boxctl.mjs up` 启动已安装版本，`node boxctl.mjs status` 查询容器状态。

默认本地入口为 `http://localhost:44176/park/login` 和 `http://localhost:44176/consult`。实际交付地址通过配置注入。Compose 中 Moss 的 `host` runtime 表示执行进程位于 Moss 容器内部。业务服务不挂载 Docker socket；独立运维容器通过 Docker Engine 管理限定项目的业务容器。

`node boxctl.mjs verify VERSION` 重新登记对应镜像的实际组件信息并执行完整交付检查；版本必须对应当前运行镜像，验证失败不会被视为交付成功。

## 数据与操作

`park-box-data` 保存业务数据、数据库、政策、Wiki、会话、运行配置及凭证。`park-box-operations-state` 独立保存持久任务、备份、升级包与恢复材料。备份暂停三个业务容器的写入，覆盖整个登记的数据卷，执行 SQLite 一致性备份、完整性与外键检查，并验证归档的逐文件清单。恢复先验证所选归档，保存当前状态，再恢复并重新进行服务、版本和真实问答检查。

在系统运营的盒子运维页面执行模型检查、备份、恢复、签名校验、升级、回滚和政策重新索引。任务与错误记录保存在独立运维卷；页面定时查询进度。升级同时替换三个业务镜像，检查运行镜像、组件构建标识、数据库迁移记录、模型配置及真实业务。失败后恢复原镜像和保护备份，分别保留原始错误与恢复错误。

若恢复本身失败，业务入口保持维护状态；排除记录中的故障后，在本目录执行 `docker compose -f compose.json exec operations python taskctl.py recover TASK_ID` 重试该任务的保护恢复。此命令也适用于业务容器不能启动、管理页面无法访问的情况。恢复仍会验证镜像、数据和真实业务，通过后才解除维护。运维容器重启会读取未完成任务并尝试恢复；不会重新执行原升级或恢复操作。

`node boxctl.mjs package VERSION` 导出该版本的三个 Docker 镜像和完整组件清单，生成签名并立即验证。签名协议为 Ed25519 签署 `park-box-release-v1`、一个零字节及完整压缩包的 SHA-256 二进制摘要。包与同名 `.sig` 位于运维卷 `artifacts/upgrades/`。签名私钥留在构建侧，运行运维容器只挂载公钥。

## 验证范围

`docker run --rm --entrypoint python park-box-operations:1 -m unittest artifacts_test -v` 执行真实密码学、SQLite 和归档检查测试。这些专项测试不能替代真实数据恢复、升级、回滚、索引与公开问答验收。安装登记和验证结果写入数据卷 `config/release.json` 与 `config/delivery.json`。未通过真实验收的能力不得标记为已验收。

本机真实执行的任务、结果和验证边界见 [ACCEPTANCE.md](ACCEPTANCE.md)。
