# Domain Context

## Organization

企业租户的唯一主实体。一个 Organization 拥有用户、资源、策略和企业配置。

## User

归属于一个 Organization 的统一身份主体。相同用户在本地模式和云端模式中共享身份、角色、状态和资源权限。

## Local Mode

在用户设备上执行对话、工具、本地定时任务和本地渠道的产品模式。企业控制面提供身份、资源和访问策略，但不替代本地执行。

## Cloud Mode

将任务交给企业平台远程执行的产品模式。企业平台负责会话、工作区、权限、恢复、模型、云端定时任务和服务端渠道。

## Agent

面向用户的统一智能体定义。Agent 的名称、版本、可见范围和组织归属只有一份；其执行 Provider 可以是本地 Runtime、Moss Runtime 或 Dify。

## Skill

可供 Agent 或会话使用的统一能力包。Skill 具有定义、版本、组织归属和可见范围，可用于本地模式或云端模式。

## Execution Provider

执行 Agent 请求的方式，包括本地执行、云端执行和外部平台执行。Provider 不拥有独立的用户、Agent 或 Skill 主数据。

## Scheduled Task

按计划触发 Agent 指令的任务。本地任务和云端任务在不同的可用性与文件系统环境运行，因此不是同一个任务实例。

## Channel

将外部消息平台与 Agent 对话连接起来的入口。渠道可以在本地或云端运行，但共享统一的用户、Agent、Skill 和权限定义。
