/**
 * Claude Code Feature Flags
 *
 * 用法：在 package.json 的 build 脚本里，把想开启的 feature 加入 --define 参数：
 *   --define 'feature("FEATURE_NAME")=true'
 *
 * 注意：这些 flag 是编译期宏（DCE），修改后需要重新执行 bun run build。
 * 对于 Node.js 构建（build:node），feature() 是运行时 stub，修改 stub 即可无需重建。
 */

// =============================================================================
// ✅ 推荐开启 —— 纯客户端功能，无外部依赖，安全稳定
// =============================================================================

export const RECOMMENDED = {

  // 自动检测终端主题（深色/浅色），无需手动设置
  AUTO_THEME: true,

  // Token 用量实时追踪，在输入框底部显示剩余 token 预算
  TOKEN_BUDGET: true,

  // 上下文折叠：长对话中折叠旧消息，减少视觉干扰
  CONTEXT_COLLAPSE: true,

  // 响应式自动压缩：上下文接近上限时自动触发 compact，比手动更智能
  REACTIVE_COMPACT: true,

  // 缓存微压缩：对重复内容使用缓存结果，加快压缩速度
  CACHED_MICROCOMPACT: true,

  // 压缩前的提醒提示：在 compact 前给 Claude 附加提示，提升压缩质量
  COMPACTION_REMINDERS: true,

  // 历史会话选择器：/resume 时用交互式 UI 选择历史会话，替代纯文本列表
  HISTORY_PICKER: true,

  // 历史记录裁剪：compaction 时智能裁剪不重要的旧消息
  HISTORY_SNIP: true,

  // /ultraplan 命令：生成超详细的多步骤执行计划
  ULTRAPLAN: true,

  // 消息操作按钮：消息旁显示复制、重试等快捷操作
  MESSAGE_ACTIONS: true,

  // 新版初始化流程：更友好的首次启动引导
  NEW_INIT: true,

  // 慢操作日志：记录耗时超过阈值的操作，便于性能分析
  SLOW_OPERATION_LOGGING: true,

  // 无人值守自动重试：非交互模式（-p）下遇到可恢复错误时自动重试
  UNATTENDED_RETRY: true,

  // 流线型输出：-p 模式下更简洁的输出格式
  STREAMLINED_OUTPUT: true,
};

// =============================================================================
// 🧪 可选开启 —— 实验性或有少量依赖，功能可用但可能不完整
// =============================================================================

export const EXPERIMENTAL = {

  // Agent 记忆快照：保存/恢复 agent 的记忆状态（需要 agents-platform stub）
  AGENT_MEMORY_SNAPSHOT: false,

  // 自动提取记忆：对话结束后自动提炼关键信息写入记忆文件
  EXTRACT_MEMORIES: false,

  // 后台 Session：允许多个 session 并行运行在后台
  BG_SESSIONS: true,

  // 主动建议：Claude 主动提出下一步操作建议（实验性，可能影响响应速度）
  PROACTIVE: true,

  // Skill 快速搜索：输入 / 时模糊搜索可用 skill
  QUICK_SEARCH: true,

  // 实验性 Skill 搜索算法：更智能但尚未稳定
  EXPERIMENTAL_SKILL_SEARCH: false,

  // 内置 Explore/Plan 子 Agent：把探索和规划拆给专用子 agent 处理
  BUILTIN_EXPLORE_PLAN_AGENTS: false,

  // MCP 富文本输出：MCP 工具结果支持格式化展示（表格、代码块等）
  MCP_RICH_OUTPUT: true,

  // MCP Skill：通过 MCP 服务器暴露 skill，扩展 /skill 能力
  MCP_SKILLS: true,

  // Workflow 脚本：支持 .workflow 格式的多步骤脚本（WorkflowTool 为 stub，功能受限）
  WORKFLOW_SCRIPTS: true,

  // 定时任务（Cron）工具：让 Claude 创建和管理 cron 触发的 agent 任务
  AGENT_TRIGGERS: true,

  // 模板支持：CLAUDE.md 中使用模板变量
  TEMPLATES: false,

  // 离开摘要：长时间无操作后，回来时显示 session 摘要
  AWAY_SUMMARY: true,

  // Prompt 缓存中断检测：检测并提示 prompt cache 失效，帮助优化 token 成本
  PROMPT_CACHE_BREAK_DETECTION: false,

  // Coordinator 模式：启用 coordinator swarm 多 worker 编排模式
  COORDINATOR_MODE: true,

  // Buddy 伴侣精灵：在终端显示像素风格的小动物陪伴图标（纯彩蛋）
  BUDDY: true,
};

// =============================================================================
// ⚠️  需要原生依赖 —— 开启前需确认对应的 vendor 二进制或系统能力存在
// =============================================================================

export const NATIVE_REQUIRED = {

  // 粘贴剪切板图片：Ctrl+V 直接粘贴截图给 Claude 分析（仅 macOS）
  // 依赖：macOS 系统剪贴板 API，无额外二进制
  NATIVE_CLIPBOARD_IMAGE: false,

  // Tree-sitter Bash 解析：更精准地解析 bash 命令结构，提升权限判断准确性
  // 依赖：vendor/tree-sitter/ 目录下的 WASM 文件（目前 vendor 中未包含）
  TREE_SITTER_BASH: false,

  // Tree-sitter 影子模式：用于对比旧解析器与 tree-sitter 的结果差异（测试用）
  // 依赖：同上
  TREE_SITTER_BASH_SHADOW: false,

  // 语音模式：通过麦克风语音输入（仅 macOS）
  // 依赖：vendor/audio-capture-src 需要编译为原生模块
  VOICE_MODE: false,

  // Web 浏览器工具：让 Claude 控制浏览器访问网页（类似 Playwright）
  // 依赖：需要 Chromium / Chrome 浏览器已安装
  WEB_BROWSER_TOOL: false,
};

// =============================================================================
// 🚫 不要开启 —— 依赖 Anthropic 内部服务，开了会报错或无效
// =============================================================================

export const INTERNAL_ONLY = {
  // --- Anthropic 内部基础设施 ---
  KAIROS: false,             // 内部推送通知系统
  KAIROS_BRIEF: false,       // Kairos 简报
  KAIROS_CHANNELS: false,    // Kairos 频道
  KAIROS_DREAM: false,       // Kairos Dream 服务
  KAIROS_GITHUB_WEBHOOKS: false, // Kairos GitHub Webhook
  KAIROS_PUSH_NOTIFICATION: false, // Kairos 推送

  CCR_AUTO_CONNECT: false,   // Claude Code Remote 自动连接
  CCR_MIRROR: false,         // CCR 镜像模式
  CCR_REMOTE_SETUP: false,   // CCR 远程初始化

  BRIDGE_MODE: false,        // 连接 claude.ai 网页版的桥接模式
  DAEMON: false,             // 后台守护进程模式
  DIRECT_CONNECT: true,      // 直连服务
  LODESTONE: false,          // 内部服务定位系统
  TORCH: false,              // 内部 ML 推理加速
  CHICAGO_MCP: false,        // 内部 MCP 服务器

  // --- 内部安全 & 合规 ---
  ANTI_DISTILLATION_CC: false,    // 反蒸馏保护
  NATIVE_CLIENT_ATTESTATION: false, // 客户端证明
  TRANSCRIPT_CLASSIFIER: false,   // 对话内容分类器（内部 ML 模型）
  BASH_CLASSIFIER: false,         // Bash 命令安全分类器（内部 ML 模型）
  ABLATION_BASELINE: false,       // A/B 测试消融基准

  // --- 内部工具 ---
  DUMP_SYSTEM_PROMPT: false,      // 输出 system prompt（内部 eval 用）
  MONITOR_TOOL: false,            // TungstenLiveMonitor（stub，无实现）
  OVERFLOW_TEST_TOOL: false,      // 溢出测试工具
  HARD_FAIL: false,               // 强制失败模式（测试用）
  ALLOW_TEST_VERSIONS: false,     // 允许测试版本号
  SHOT_STATS: false,              // 内部统计
  PERFETTO_TRACING: false,        // Perfetto 性能追踪
  MEMORY_SHAPE_TELEMETRY: false,  // 内存结构遥测

  // --- 内部云服务 ---
  DOWNLOAD_USER_SETTINGS: false,  // 从 Anthropic 云同步用户设置
  UPLOAD_USER_SETTINGS: false,    // 上传用户设置到 Anthropic 云
  BYOC_ENVIRONMENT_RUNNER: false, // BYOC 环境运行器
  SELF_HOSTED_RUNNER: false,      // 自托管运行器
  FILE_PERSISTENCE: false,        // 云端文件持久化（BYOC 模式）

  // --- 内部 IDE/平台集成 ---
  SSH_REMOTE: false,         // SSH 远程连接
  TERMINAL_PANEL: false,     // IDE 终端面板
  UDS_INBOX: false,          // Unix Domain Socket 收件箱
  BUILDING_CLAUDE_APPS: false, // 构建 Claude App 的特殊 UI

  // --- 其他内部功能 ---
  CONNECTOR_TEXT: false,          // 连接器文本块（stub，无实现）
  COWORKER_TYPE_TELEMETRY: false, // 协作者类型遥测
  TEAMMEM: false,                 // 团队共享记忆（需要内部服务）
  VERIFICATION_AGENT: false,      // 验证 agent（需要内部服务）
  REVIEW_ARTIFACT: false,         // Review artifact（内部 CR 系统）
  SKILL_IMPROVEMENT: false,       // Skill 质量改进上报
  RUN_SKILL_GENERATOR: false,     // Skill 生成器（内部工具）
  ENHANCED_TELEMETRY_BETA: false, // 增强遥测 beta
  BREAK_CACHE_COMMAND: false,     // 手动触发缓存中断（内部调试）
  IS_LIBC_GLIBC: false,           // 构建环境标记
  IS_LIBC_MUSL: false,            // 构建环境标记
  POWERSHELL_AUTO_MODE: false,    // PowerShell 自动模式（Windows 内部）
  FORK_SUBAGENT: false,           // Fork 子 agent（实验性，不稳定）
};
