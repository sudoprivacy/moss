# 平台配置与登录隔离实施

基线 origin/dev f55e42b；分支 codex/platform-config-login-isolation。

1. 同步基线、隔离工作区、细化实施 — complete
2. Moss 认证隔离、组织策略、默认密码与改密 — complete
3. 公共平台配置服务、全局权限与运行时接管 — complete
4. 平台配置/个人改密/组织登录展示页面 — complete
5. 迁移预览与实施文档 — complete
6. 回归测试、构建、审查和提交 — complete

要求：手机号默认密码可直接登录、不强制激活或改密；现有密码保留。只实现和验证，尚未授权生产部署。原始工作区迁移改动不得覆盖。
