# `cc-haha` Chat UI 迁移计划

## 1. 目标

将当前 `moss/ui` 对话区迁移到 `~/repo/cc-haha` 的展示模型，目标是尽量做到以下部分 1:1：

- 每条用户消息与助手消息的消息壳、布局、间距、交互
- 每个 tool 的分组、卡片、展开收起、结果内联展示
- 富文本正文、代码块、表格、引用、长文档模式
- copy 交互，包括消息 copy、代码 copy、tool input/output copy
- thinking、streaming、tool 执行中的状态表现

同时必须保留 `moss/ui` 已经适配好的本地能力：

- 本地图片路径与 `moss-image://` 协议渲染
- 本地文件附件预览
- worker transcript 面板与恢复逻辑
- 现有主题系统、桌面端 IPC、预览抽屉

## 2. 当前状态

### 2.1 当前 `moss/ui` 的问题

- 对话区仍然是单一 `MessageBubble` 模型，assistant 正文、thinking、tools 都堆在同一层。
- tool UI 主要依赖 `tool-steps.tsx` 做统一摘要，不是按 tool 类型做差异化展示。
- markdown 只够“可用”，但没有 `cc-haha` 的文档模式、代码块体系、Mermaid 识别、统一 copy 体系。
- 消息 copy 交互粗糙，而且当前按钮本身有错误配置。

### 2.2 当前 `moss/ui` 关键文件

- `src/renderer-react/lib/agent-transcript.ts`
- `src/renderer-react/components/chat-transcript.tsx`
- `src/renderer-react/components/tool-steps.tsx`
- `src/renderer-react/components/markdown-view.tsx`
- `src/renderer-react/components/chat-area.tsx`
- `src/renderer-react/components/worker-thread-panel.tsx`
- `src/renderer-react/components/local-image.tsx`
- `src/renderer-react/components/file-preview.tsx`
- `src/renderer-react/globals.css`
- `index.html`

### 2.3 目标参考文件：`cc-haha`

- `desktop/src/components/chat/MessageList.tsx`
- `desktop/src/components/chat/UserMessage.tsx`
- `desktop/src/components/chat/AssistantMessage.tsx`
- `desktop/src/components/chat/ThinkingBlock.tsx`
- `desktop/src/components/chat/MessageActionBar.tsx`
- `desktop/src/components/shared/CopyButton.tsx`
- `desktop/src/components/chat/clipboard.ts`
- `desktop/src/components/chat/ToolCallGroup.tsx`
- `desktop/src/components/chat/ToolCallBlock.tsx`
- `desktop/src/components/chat/ToolResultBlock.tsx`
- `desktop/src/components/chat/CodeViewer.tsx`
- `desktop/src/components/chat/DiffViewer.tsx`
- `desktop/src/components/chat/TerminalChrome.tsx`
- `desktop/src/components/markdown/MarkdownRenderer.tsx`

## 3. 迁移原则

### 3.1 总原则

- 不在现有 `chat-transcript.tsx` / `tool-steps.tsx` / `markdown-view.tsx` 上继续累加补丁。
- 先完成新的聊天渲染层，再逐步切换入口。
- 先改“数据表达能力”，再改 UI 壳与样式。
- 保留 `moss/ui` 的本地能力与桌面适配，不反向迁成纯 Web 组件。

### 3.2 推荐目录结构

新增聊天渲染目录：

- `src/renderer-react/components/chat/`
- `src/renderer-react/components/markdown/`

推荐让旧组件保留为兼容层，避免一次性改掉所有引用。

## 4. 迁移范围

### 4.1 必须 1:1 对齐的能力

- 用户消息布局与 copy 行为
- 助手消息布局与 document layout 自动切换
- thinking block 展开/收起与活动态
- tool group、tool call、tool result 的布局与层级
- markdown 富文本样式
- code viewer 头部、行数、折叠、copy
- tool input/output 的 copy 交互
- Bash / Edit / Write / Read / Grep / Glob / Agent / Web 工具卡片

### 4.2 必须保留的本地能力

- `LocalImage` 的本地路径、`file://`、`moss-image://` 支持
- `FilePreview` 的文件元数据与图片缩略图
- worker 结果从 `.jsonl` 恢复并在面板中展示
- 现有 `globals.css` 的 light/dark 与 preset theme 机制
- preview drawer 的 Markdown/Code/Diff 预览，不与聊天区强耦合

### 4.3 非首轮目标

- preview drawer 视觉完全向 `cc-haha` 对齐
- `cc-haha` 里和聊天区无关的 rewind、permission、toast、team/session 逻辑
- 整个应用外壳、sidebar、header 迁成 `cc-haha`

## 5. 数据层改造方案

### 5.1 现状

当前 `agent-transcript.ts` 把会话直接压成：

- `ChatMessage.role = user | assistant`
- `ChatMessage.toolSteps?: ToolStep[]`

这会导致：

- 不能把 `tool_use` 和 `tool_result` 分开渲染
- 不能按 `parent_tool_use_id` 建 tool 树
- 不能复用 `cc-haha` 的 `MessageList -> ToolCallGroup -> ToolCallBlock` 结构

### 5.2 目标模型

建议在 `moss/ui` 内引入新的聊天渲染消息模型，命名建议：

- `TranscriptRenderMessage`
- `TranscriptRenderItem`

建议的消息类型：

- `user_text`
- `assistant_text`
- `thinking`
- `tool_use`
- `tool_result`
- `system`

建议字段：

- `id`
- `timestamp`
- `toolUseId`
- `parentToolUseId`
- `toolName`
- `input`
- `content`
- `isError`
- `attachments` 或图片/文件引用

### 5.3 具体改法

#### 修改文件

- `src/renderer-react/lib/agent-transcript.ts`

#### 修改内容

- 保留现有 `buildMainChatMessagesFromHistory` 的外部调用点，但内部输出改为新 render message 列表。
- 新增或重命名 builder，建议：
  - `buildMainChatRenderMessagesFromHistory`
  - `buildWorkerRenderMessagesFromSubagentEvents`
- 在解析 `stream_event`、`assistant`、`user`、`result`、`tool_result` 时，不再把 tool 合并成 `toolSteps`。
- 保留 `tool_use_id` 与 `parent_tool_use_id`，让上层能做 `ToolCallGroup`。
- 保留已有的本地图片路径提取逻辑，继续从 tool result 中抽取图片。
- 用户消息附件继续从 `event.images` / `event.files` 派生，但渲染层与消息正文解耦。

### 5.4 过渡策略

- 首轮可以保留 `ChatMessage` 类型定义，新增新的 render message 类型，避免一次性影响过大。
- 等 `ChatTranscript` 完全切到新体系后，再考虑删除 `ChatMessage.toolSteps`。

## 6. 组件级迁移方案

### 6.1 消息列表层

#### 新增文件

- `src/renderer-react/components/chat/message-list.tsx`

#### 来源映射

- 参考 `cc-haha`: `desktop/src/components/chat/MessageList.tsx`

#### 负责功能

- 根据 render message 构建渲染项
- tool group 折叠/展开
- 把 `user_text`、`assistant_text`、`thinking`、`tool_use`、`tool_result` 分发给不同 block
- 维持自动滚动到底部的逻辑

#### 需要从当前代码迁入/复用

- 当前 `ChatTranscript` 的底部滚动逻辑
- `chat-area.tsx` 的 `bottomRef`
- worker panel 内部复用同一套 renderer

### 6.2 用户消息

#### 新增文件

- `src/renderer-react/components/chat/user-message.tsx`
- `src/renderer-react/components/chat/message-action-bar.tsx`
- `src/renderer-react/components/shared/copy-button.tsx`
- `src/renderer-react/components/chat/clipboard.ts`

#### 来源映射

- `cc-haha`:
  - `UserMessage.tsx`
  - `MessageActionBar.tsx`
  - `CopyButton.tsx`
  - `clipboard.ts`

#### 负责功能

- 用户消息壳
- 底部 action bar
- 文本 copy
- 未来可扩展 rewind，但首轮可不接

#### 与本地能力的接点

- 继续接入 `FilePreview`
- 用户附件如果有图片或文件，仍使用 `FilePreview`

### 6.3 助手消息

#### 新增文件

- `src/renderer-react/components/chat/assistant-message.tsx`

#### 来源映射

- `cc-haha`: `AssistantMessage.tsx`

#### 负责功能

- bubble/document layout 自动切换
- 助手正文 copy
- streaming 光标
- 与 markdown renderer 对接

#### 迁移要求

- 当前 `moss` 不需要强依赖 avatar 壳；可以先保留当前整体页面的头像逻辑，再把消息壳切成 `cc-haha` 样式
- 重点是正文排版和操作条，头像不是阻塞项

### 6.4 Thinking Block

#### 新增文件

- `src/renderer-react/components/chat/thinking-block.tsx`

#### 来源映射

- `cc-haha`: `ThinkingBlock.tsx`

#### 负责功能

- 折叠/展开
- 活动状态自动滚动到底部
- preview line 与活动指示

#### 当前文件处理

- `src/renderer-react/components/chat-transcript.tsx` 内联 `ThinkingBlock` 删除

### 6.5 Tool Group

#### 新增文件

- `src/renderer-react/components/chat/tool-call-group.tsx`
- `src/renderer-react/components/chat/tool-call-block.tsx`
- `src/renderer-react/components/chat/tool-result-block.tsx`

#### 来源映射

- `cc-haha`:
  - `ToolCallGroup.tsx`
  - `ToolCallBlock.tsx`
  - `ToolResultBlock.tsx`

#### 负责功能

- tool use/result 分组
- 同级 tool 合并成 group
- parent/child tool tree
- Agent tool 嵌套展示
- 运行中、成功、失败状态

#### 替换关系

- 新体系接管主聊天区 tool 展示
- `src/renderer-react/components/tool-steps.tsx` 从主对话流移除

### 6.6 Code / Diff / Terminal

#### 新增文件

- `src/renderer-react/components/chat/code-viewer.tsx`
- `src/renderer-react/components/chat/diff-viewer.tsx`
- `src/renderer-react/components/chat/terminal-chrome.tsx`

#### 来源映射

- `cc-haha`:
  - `CodeViewer.tsx`
  - `DiffViewer.tsx`
  - `TerminalChrome.tsx`

#### 负责功能

- 代码块专用 viewer
- Edit / Write 工具 diff 展示
- Bash 工具命令展示
- 代码 copy、行数、折叠展开

#### 与现有代码的关系

- 聊天区使用新 `CodeViewer`
- preview drawer 保留当前 `src/renderer-react/components/preview/viewers/CodeViewer.tsx`
- 不建议首轮合并成一套组件，避免聊天区与预览区耦合

### 6.7 Markdown Renderer

#### 新增文件

- `src/renderer-react/components/markdown/markdown-renderer.tsx`
- 可选：`src/renderer-react/components/chat/mermaid-renderer.tsx`

#### 来源映射

- `cc-haha`: `desktop/src/components/markdown/MarkdownRenderer.tsx`

#### 负责功能

- prose 排版
- 文档模式
- table wrapper
- code block 抽离渲染
- blockquote / list / heading / link 统一样式
- Mermaid 检测与渲染

#### 保留本地能力

- 图片节点继续使用 `src/renderer-react/components/local-image.tsx`

#### 当前文件处理

- `src/renderer-react/components/markdown-view.tsx` 改成兼容 wrapper 或逐步废弃

## 7. 接入点修改清单

### 7.1 `src/renderer-react/App.tsx`

#### 当前职责

- 通过 `buildMainChatMessagesFromHistory(activeDetail?.history || [])` 派生主聊天消息
- 通过 `buildWorkerMessagesFromSubagentEvents(...)` 派生 worker 消息

#### 迁移修改

- 改为调用新的 render message builder
- `resolvedWorkerThreads` 中的 `messages` 类型同步升级
- 保持 worker summary 持久化逻辑不变，只调整 `messages` 在内存中的结构

#### 风险

- 这是整个聊天链路的入口，改动后主聊天与 worker 都会受影响

### 7.2 `src/renderer-react/components/chat-area.tsx`

#### 迁移修改

- 将 `ChatTranscript` 替换为新的 `MessageList`
- 保留 `ScrollArea`、`bottomRef`、`pendingPlanApproval` 与 composer 区域
- 删除旧的 `renderTextSegments` 等只服务于旧消息壳的逻辑

#### 当前可删除或降级的导入

- `ChatTranscript`
- `MarkdownView`
- 旧的内嵌消息分段逻辑

### 7.3 `src/renderer-react/components/worker-thread-panel.tsx`

#### 迁移修改

- 内部由 `ChatTranscript` 切换到新 `MessageList`
- 外层 worker 面板 UI 保留
- worker prompt/resultText 头部展示保留

## 8. 样式与主题迁移

### 8.1 修改文件

- `src/renderer-react/globals.css`
- `index.html`

### 8.2 需要补的 token

建议新增以下语义变量，使聊天区能承载 `cc-haha` 样式，但仍走 `moss` 主题系统：

- `--color-surface`
- `--color-surface-container-lowest`
- `--color-surface-container-low`
- `--color-surface-container`
- `--color-surface-container-high`
- `--color-surface-container-highest`
- `--color-surface-user-msg`
- `--color-text-primary`
- `--color-text-secondary`
- `--color-text-tertiary`
- `--color-outline`
- `--color-outline-variant`
- `--color-brand`
- `--color-success`
- `--color-warning`
- `--color-error-container`
- `--color-code-bg`
- `--color-code-fg`
- `--color-code-comment`
- `--color-code-string`
- `--color-code-keyword`
- `--color-code-function`
- `--color-code-type`
- `--color-code-number`
- `--color-code-parameter`
- `--color-code-property`
- `--color-code-punctuation`
- `--color-code-inserted`
- `--color-code-deleted`

### 8.3 字体与图标

#### 严格 1:1 方案

- 引入 `Manrope`、`Inter`、`JetBrains Mono`
- 引入 `Material Symbols Outlined`

#### 推荐方案

- 首轮保留 `Geist` / `Geist Mono`
- 引入 `Material Symbols Outlined`
- 如果需要更接近 `cc-haha`，第二轮再切字体

#### 说明

- 不建议直接依赖在线 Google Fonts 链接
- 更稳妥的方案是本地打包字体资源或使用现有字体近似替代

## 9. 依赖变更计划

### 9.1 当前已具备

- `react-markdown`
- `remark-gfm`
- `react-syntax-highlighter`

### 9.2 若追求更接近 `cc-haha`，建议新增

- `dompurify`
- `marked`
- `react-shiki`
- `mermaid`

### 9.3 依赖策略建议

#### 推荐策略

- 第一阶段先引入 `dompurify`、`marked`
- 第二阶段再决定是否引入 `react-shiki` 与 `mermaid`

#### 原因

- `react-shiki` 与 `mermaid` 会增加体积与加载复杂度
- 首轮先完成消息壳、tool 壳、markdown 结构与 copy 体系，收益最大

## 10. 文件级改动清单

### 10.1 修改文件

| 文件 | 动作 | 作用 |
| --- | --- | --- |
| `src/renderer-react/lib/agent-transcript.ts` | 大改 | 输出新的 render message 结构，保留 tool 层级与本地附件能力 |
| `src/renderer-react/App.tsx` | 中改 | 主会话与 worker 会话改用新的 render message builder |
| `src/renderer-react/components/chat-area.tsx` | 大改 | 聊天区切换到新 `MessageList` |
| `src/renderer-react/components/worker-thread-panel.tsx` | 中改 | worker transcript 改用新 renderer |
| `src/renderer-react/components/markdown-view.tsx` | 降级/兼容 | 过渡期 wrapper，后续可删 |
| `src/renderer-react/components/chat-transcript.tsx` | 降级/兼容 | 过渡期 wrapper，后续可删 |
| `src/renderer-react/components/tool-steps.tsx` | 降级/兼容 | 不再用于主聊天区 |
| `src/renderer-react/components/local-image.tsx` | 小改 | 接入新 markdown renderer |
| `src/renderer-react/components/file-preview.tsx` | 小改 | 与新消息壳兼容 |
| `src/renderer-react/globals.css` | 中改 | 补充语义 token 与聊天区样式变量 |
| `index.html` | 小改 | 引入图标字体或本地图标资源 |
| `package.json` | 中改 | 增加 markdown/code 相关依赖 |

### 10.2 新增文件

| 文件 | 来源 | 作用 |
| --- | --- | --- |
| `src/renderer-react/components/chat/message-list.tsx` | `cc-haha/MessageList.tsx` | 新聊天渲染入口 |
| `src/renderer-react/components/chat/user-message.tsx` | `cc-haha/UserMessage.tsx` | 用户消息壳 |
| `src/renderer-react/components/chat/assistant-message.tsx` | `cc-haha/AssistantMessage.tsx` | 助手消息壳 |
| `src/renderer-react/components/chat/thinking-block.tsx` | `cc-haha/ThinkingBlock.tsx` | thinking block |
| `src/renderer-react/components/chat/message-action-bar.tsx` | `cc-haha/MessageActionBar.tsx` | 消息底部操作条 |
| `src/renderer-react/components/shared/copy-button.tsx` | `cc-haha/CopyButton.tsx` | 通用 copy 按钮 |
| `src/renderer-react/components/chat/clipboard.ts` | `cc-haha/clipboard.ts` | 兼容 clipboard fallback |
| `src/renderer-react/components/chat/tool-call-group.tsx` | `cc-haha/ToolCallGroup.tsx` | tool 分组渲染 |
| `src/renderer-react/components/chat/tool-call-block.tsx` | `cc-haha/ToolCallBlock.tsx` | tool 调用卡片 |
| `src/renderer-react/components/chat/tool-result-block.tsx` | `cc-haha/ToolResultBlock.tsx` | tool 结果卡片 |
| `src/renderer-react/components/chat/code-viewer.tsx` | `cc-haha/CodeViewer.tsx` | 聊天区代码查看器 |
| `src/renderer-react/components/chat/diff-viewer.tsx` | `cc-haha/DiffViewer.tsx` | diff 卡片 |
| `src/renderer-react/components/chat/terminal-chrome.tsx` | `cc-haha/TerminalChrome.tsx` | Bash 卡片外壳 |
| `src/renderer-react/components/markdown/markdown-renderer.tsx` | `cc-haha/MarkdownRenderer.tsx` | 富文本渲染器 |
| `src/renderer-react/components/chat/mermaid-renderer.tsx` | `cc-haha/MermaidRenderer.tsx` | Mermaid 图表渲染（使用 `mermaid` + `DOMPurify`） |
| `src/renderer-react/components/chat/inline-image-gallery.tsx` | `cc-haha/InlineImageGallery.tsx` | 可选，文本中图片路径识别 |

### 10.3 第二阶段可删除文件

- `src/renderer-react/components/chat-transcript.tsx`
- `src/renderer-react/components/tool-steps.tsx`
- `src/renderer-react/components/markdown-view.tsx`

说明：建议第二阶段删除。第一阶段先保留 wrapper，降低切换风险。

## 11. 分阶段实施清单

### 阶段 A：数据层

- [x] 在 `agent-transcript.ts` 新增 render message 类型
- [x] 主会话 history 输出新 render message 列表
- [x] worker `.jsonl` 输出新 render message 列表
- [x] 校验 tool use/result 与 parent 关系完整
- [x] 校验本地图片、文件路径未丢失

### 阶段 B：消息层

- [x] 落 `message-list.tsx`
- [x] 落 `user-message.tsx`
- [x] 落 `assistant-message.tsx`
- [x] 落 `thinking-block.tsx`
- [x] 落 `message-action-bar.tsx`
- [x] 落 `copy-button.tsx`
- [x] 统一 clipboard fallback

### 阶段 C：富文本层

- [x] 落 `markdown-renderer.tsx`
- [x] 落 `code-viewer.tsx`
- [x] 落 `diff-viewer.tsx`
- [x] 落 `terminal-chrome.tsx`
- [x] 接 `LocalImage`
- [x] 接代码 copy、tool output copy
- [x] 视情况接 `Mermaid`

### 阶段 D：tool 层

- [x] 落 `tool-call-group.tsx`
- [x] 落 `tool-call-block.tsx`
- [x] 落 `tool-result-block.tsx`
- [x] 接 Bash / Read / Write / Edit / Grep / Glob / Agent / Web
- [x] 接 nested tool tree
- [x] 接 agent 工具状态卡片

### 阶段 E：接入层

- [x] `App.tsx` 改用新 builder
- [x] `chat-area.tsx` 改用新 `MessageList`
- [x] `worker-thread-panel.tsx` 改用新 `MessageList`
- [x] 旧组件降级为 wrapper

### 阶段 F：样式/依赖/清理

- [x] `globals.css` 补 token
- [x] 引入图标字体（`@fontsource-variable/material-symbols-outlined`，已在 `main.tsx` import）
- [x] 增加 markdown/code 依赖（`dompurify`、`marked`、`mermaid` 已在 `package.json`，`dompurify` 已在 mermaid-renderer 使用）
- [x] 删除不再使用的旧聊天组件（`chat-transcript.tsx`、`tool-steps.tsx`、`markdown-view.tsx` 已删除）

### 阶段 G：第二轮可选

- [ ] 引入 `react-shiki` 替换 `react-syntax-highlighter`
- [ ] 引入 `marked` 替换 `react-markdown`（当前 `react-markdown` + `remark-gfm` 工作良好，按需再换）
- [ ] 字体从 `Geist`/`Geist Mono` 切换到 `Manrope`/`Inter`/`JetBrains Mono`
- [ ] `inline-image-gallery.tsx`（可选，文本中图片路径识别）

## 12. 验收标准

### 12.1 消息展示

- 用户消息与助手消息视觉结构接近 `cc-haha`
- 助手长文自动切换 document layout
- streaming 态不出现 layout 抖动

### 12.2 富文本

- 标题、列表、表格、引用、代码块、图片、链接都正确
- 代码块有独立 header、行数、copy、折叠
- 本地图片与远程图片都能显示

### 12.3 Tool

- tool use 与 tool result 正确配对
- 多个同级 tool 会被 group
- Agent tool 有层级树和状态
- Edit / Write 有 diff，Bash 有 terminal 壳

### 12.4 本地能力

- `LocalImage` 继续支持本地路径和 `moss-image://`
- `FilePreview` 继续显示文件与图片附件
- worker transcript 继续正常恢复

### 12.5 交互

- 消息 copy 可用
- 代码 copy 可用
- tool input/output copy 可用
- 展开/收起、hover action bar、自动滚动行为正常

## 13. 验证方案

### 13.1 自动检查

- `npm run check`
- 若新增依赖，确保 `package-lock.json` 与 `package.json` 同步

### 13.2 手工回归场景

- 纯文本对话：
  - 用户消息
  - 助手短回复
  - 助手长回复
- markdown 富文本：
  - 标题
  - 列表
  - 表格
  - 引用
  - 代码块
  - 图片
  - 链接
- tool 场景：
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - Web
- 运行状态：
  - streaming 中
  - thinking 中
  - tool 执行中
  - tool error
- 本地能力：
  - `moss-image://` 图片
  - `file://` 图片
  - 本地路径图片
  - 文件附件预览
  - worker panel 恢复

### 13.3 视觉比对

- 对同一段对话，在 `cc-haha` 和 `moss/ui` 中截相同区域
- 重点比对：
  - assistant 文本宽度
  - 长文 document layout
  - code viewer 头部与底部
  - tool group 与 tool card 层级
  - action bar 的出现位置与 hover 行为
  - thinking block 的密度与展开样式

## 14. 实施前需要拍板的决策

### 决策 1：Markdown / Code 依赖深度

- 方案 A：尽量贴近 `cc-haha`，引入 `dompurify`、`marked`、`react-shiki`、`mermaid`
- 方案 B：只引入 `dompurify`、`marked`，代码高亮继续先用现有方案

推荐：

- 第一轮先按方案 B 落地
- 第二轮再补 `react-shiki` 与 `mermaid`

### 决策 2：字体是否追求严格一致

- 方案 A：保留 `Geist` / `Geist Mono`
- 方案 B：切换到 `Manrope` / `Inter` / `JetBrains Mono`

推荐：

- 第一轮保留现有字体
- 图标先补齐 `Material Symbols`
- 需要更高像素一致性时再切字体

### 决策 3：旧组件是否立即删除

- 方案 A：首轮保留 wrapper
- 方案 B：切换后立即删除

推荐：

- 首轮保留 wrapper
- 至少等主聊天区和 worker 面板都稳定后再删

## 15. 风险与应对

### 风险 1：数据模型切换影响范围大

应对：

- 首轮新增 render message 类型，不直接删除旧 `ChatMessage`
- builder 与 UI 一起双轨过渡

### 风险 2：markdown/code 依赖过重

应对：

- 先接 `marked + dompurify`
- `react-shiki` 与 `mermaid` 延后到第二阶段

### 风险 3：本地图片能力被新 renderer 绕过

应对：

- 所有聊天区图片节点强制走 `LocalImage`
- 不直接照搬 `cc-haha` 的图片组件

### 风险 4：worker 区与主聊天区分叉

应对：

- worker 内部也复用同一个 `MessageList`
- 只保留 worker panel 的外层容器差异

## 16. 推荐实施顺序

推荐按以下顺序落地：

1. `agent-transcript.ts`
2. `message-list.tsx` + 消息壳 + copy 体系
3. `markdown-renderer.tsx` + `code-viewer.tsx`
4. `tool-call-group.tsx` + `tool-call-block.tsx`
5. `chat-area.tsx` / `worker-thread-panel.tsx` 接入
6. `globals.css` / `index.html` / `package.json`
7. 删除旧聊天组件

## 17. 实施建议

建议不要一次性“边改边替换”老文件，而是先新增整套聊天渲染目录，再在 `chat-area.tsx` 做一次明确切换。这样最容易保证：

- 对比清晰
- 回滚简单
- 不把旧聊天逻辑与新聊天逻辑混在一起

---

该计划文档是本次 `cc-haha` 对话区迁移的实施底稿。下一步可以按本文件的文件级清单逐项落地。
