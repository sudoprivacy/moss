# Moss admin UI prototype

独立的系统设置交互原型。无需登录，不连接 Moss API，不读取真实配置或凭据。

## 运行与检查

在仓库根目录执行：

```bash
bun run --cwd admin dev:prototype
```

打开 http://127.0.0.1:5175/ 。桌面应用中也可以启动 `.claude/launch.json` 的 `moss-admin-prototype`。

```bash
bun run --cwd admin check:prototype
```

```bash
bun run --cwd admin build:prototype
```

构建输出为 `admin/prototype-dist`，与真实管理端的 `admin/dist` 隔离。原有 `build` 和 `dev` 命令不变。原型 Vite 配置无 API 代理，也不加载 admin 的环境变量文件。

## 交互范围

- 分组侧栏、收起/展开、移动端抽屉。
- 示例工作空间切换；全局配置不会随工作空间切换。
- 模型配置、执行与权限、客户端与集成三个标签页。
- 表单编辑、URL/整数校验、变更预览、取消和保存反馈。
- 示例密钥显隐、图片模型开关、模拟连接测试。
- Cmd/Ctrl+K 搜索导航和设置。
- 深浅色切换、脱敏配置预览/复制、设计说明。
- 未实现的导航入口明确显示原型范围说明，不执行真实跳转。

所有状态仅在 React 内存中保存，刷新即重置，不写入 localStorage、Cookie 或磁盘。请勿填写真实密钥。模拟连接测试只有本地状态变化，不会测试真实服务。

## 设计方向

浅灰侧栏 + 白色工作区 + 苔绿强调色。用紧凑的分组导航、轻边框表单分区、固定保存栏和配置作用域说明替代大面积空白、重复阴影卡片与不明确的自动保存。

基础色：`#F6F8F7` / `#FFFFFF` / `#242C28` / `#E5E9E6` / `#245C48` / `#E5EFE8`。字体使用本机系统字体，路径及配置使用等宽字体；不加载远程字体或图像。

复用已有 Button、Dialog、Tabs、Switch UI primitives；不导入真实 AuthProvider、业务侧栏、路由入口或任何 API 模块。

### 参考来源

- [Linear: Personalized sidebar and new settings pages](https://linear.app/changelog/2024-12-18-personalized-sidebar) — 导航分组、降低菜单噪音。
- [Vercel: Project settings](https://vercel.com/docs/project-configuration/project-settings) / [General settings](https://vercel.com/docs/project-configuration/general-settings) — 配置分类、作用域与变更生效说明。
- [Dify: Model Providers](https://docs.dify.ai/en/self-host/use-dify/workspace/model-providers) — 提供商、凭据与默认模型之间的区分。

这些是交互与信息架构参考，并非像素级复刻；模型名称、连接信息和身份均为示例，不表示真实服务支持或可用性。
