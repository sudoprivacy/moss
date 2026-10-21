# 托管运行评测

Moss 管理页现在可以为已审核登记的内部托管 Dify/LangGraph 制品选择不可变评测集，启动并查看逐用例结果、运行节点和模型调用关联。这是迁移后的评测记录；登记、运行成功与评分本身都不会授予 L2 或发布版本。

## 操作与状态

组织管理员进入“智能体管理 → 智能体台账”，选择条目的“托管制品”。先登记预置镜像及评测集，再选择两者开始评测。所有样本都进入分母，包括失败、停止和未知结果。精确匹配只去除 ASCII 首尾空白；浏览器不能提交评分、执行身份、lease 或密钥。

页面定期只读刷新。负责人可以查看自己的记录；组织管理员可以启动、继续尚未开始的用例、停止或核对超时与凭证回收。每个新用例和模型调用都重新检查当前组织成员与管理权限。未确认的已开始用例永不自动重发。停止会关闭排队用例并撤销 IAM，无法据此断言远端容器已取消。

Nexus Registry 持久化评测及一次性 claim。Moss 调用正式 Nexus supervisor，在隔离容器内执行固定制品；模型经 Nexus 内容检查、实际 IAM 授权、Router 短期凭证和账单路径。评测记录不是新的通用 Task 权威。运行节点是 worker 上报，模型关联由执行服务记录；费用以 Router 核验结果为准。

未知调用可能已计费。核对操作只补查账单、回收凭证，不重发模型，也不把已知费用改写成成功结果。容器清理未确认会阻止同一评测继续；当前核对不能制造容器清理证明，需部署人员核对执行节点。

## 部署装配

设置绝对路径 `MOSS_AGENT_HOSTED_CONFIG_FILE`。未配置时管理台仍能登记和查看；运行入口明确拒绝。配置缺失或非法时服务启动失败，不回退到直连模型。配置示例中的路径和 ID 需换成现场已有授权资源：

```json
{
  "runner": {
    "python": "/opt/nexus/bin/python",
    "docker": "/usr/bin/docker"
  },
  "relays": [{
    "id": "office-relay", "port": 22161,
    "credentialFile": "/run/secrets/hosted-relay-token",
    "nexus": {
      "endpoint": "https://127.0.0.1:22160",
      "model_mounts": ["/cloud-model"],
      "tls": {"ca": "/run/tls/ca.pem", "cert": "/run/tls/node.pem", "key": "/run/tls/node-key.pem", "serverName": "nexus-node"}
    }
  }],
  "resources": [{
    "orgId": "organization-id", "id": "evaluation-model",
    "model": "approved-model", "endpoint": "http://127.0.0.1:22146/v1",
    "maxOutputTokens": 128, "allowedAddresses": ["127.0.0.1"],
    "relayId": "office-relay", "modelMount": "/cloud-model",
    "router": {"baseUrl": "http://127.0.0.1:22146", "accountId": 1, "consoleTokenFile": "/run/secrets/router-console", "quotaPerCall": 25000, "group": "default"}
  }]
}
```

- Nexus 必须预置对应内容闸、模型挂载及同实例 relay 上游；relay 仅监听 loopback，不保存 Router 模型密钥到 VFS 请求。
- Registry zone 和实际 IAM 必须已配置 evaluator/gateway 服务主体；采用既有 Registry 显式 schema 初始化流程，先备份，常规启动不自动迁移 owner 数据。
- 所有引用的凭证和 TLS 私钥必须是仅所有者可读的文件。容器不收到 IAM/Router 密钥；不得提供宿主机目录、网络、设备或额外 capabilities。
- 预置已审镜像、Python 依赖及 supervisor。运行禁止拉取镜像。`modulePath` 仅供受控源码部署指定 Nexus 模块路径，不能由任务或浏览器设置。
- 多实例必须各有独立 loopback relay 与明确的 Nexus 上游关联。本轮只验证单实例；不能据此宣称 PostgreSQL/HA 已验收。

## 本轮验证与边界

2026-10-21 真实 CUA 管理页启动固定 Dify 制品，两个算术样本返回 42、13，2/2 通过；容器正常退出清理、IAM 回收及两笔真实 Router 账单核对通过。之前的三笔结果未知调用也核对到了账单，保持未知且未重发。

实测发现飞书 SDK 会将共享 Protobuf Long 支持设为 undefined，导致打包服务收到数字型空游标。已在模型响应边界接受精确的非负安全整数，规范化为字符串，并拒绝不安全整数、非法或越界 uint64 值；验证包含多次空轮询只写入一次请求。临时诊断日志未进入源码或交付构建。

新增 owner 生命周期测试与既有 IAM/Registry 回归、Moss 协调器/SDK/权限/响应读取测试通过。真实记录保留在隔离验收环境，私有配置与凭证不进入仓库。完整检查结果及精确提交在批次交接记录中归档。

仍需：独立迁移前基线与固定阈值对比、L2 证据准入、标准托管 Task 与 Work 调用、异常容器清理的可恢复证明、全部协议计量、工具/IM/成本及其余 1.1 验收。本功能不宣称完整 R2、R3 或 Agent 管理 1.1 完成。
