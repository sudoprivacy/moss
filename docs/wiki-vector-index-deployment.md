# Wiki 向量索引部署指南

Moss 文档中心从此版本起，wiki 构建期会在每个 wiki 目录里多产出两个文件：

```
$MOSS_HOME/wikis/<wikiId>/
  _moss_index.bin       Float32 嵌入向量（raw，无 header）
  _moss_index.jsonl     manifest + 每个 passage 的元数据
```

Agent 检索（`/api/v1/agent/wikis/:id/search`）会自动用 grep + 向量做 RRF 融合。如果向量索引不存在或嵌入模型加载失败，**自动降级为 grep-only**，wiki 仍可用。

---

## 1. 默认行为

- 默认开启：`wikiIndex.enabled = true`（`server.json`）
- 默认模型：`Xenova/multilingual-e5-small`（384 维，~120MB，中英多语）
- 模型缓存目录：`$MOSS_HOME/models/<modelId>/`，可用环境变量 `MOSS_MODELS_DIR` 覆盖
- 首次启动时若本地缺模型，会**尝试一次性下载**到上述目录；下载失败则降级 grep-only 并在日志中提示

```text
[wikiIndex] model "Xenova/multilingual-e5-small" not present at /Users/<u>/.moss/models/Xenova/multilingual-e5-small;
attempting download from huggingface.co. Set MOSS_MODEL_MIRROR or pre-seed the directory to skip this on next boot.
```

## 2. 镜像自带模型（容器化部署默认机制）

容器化部署（`deploy/server.Dockerfile` / `deploy/server.Dockerfile.local`）**默认把嵌入模型烤进镜像**，运行时无需联网下载，也无需 rsync 预置。机制：

- `MOSS_MODELS_DIR` 环境变量可覆盖模型缓存目录（见 `src/utils/wikis/localWikiDirectories.ts`）。
- server 镜像把模型烤进 `/app/models` 并设 `ENV MOSS_MODELS_DIR=/app/models`。
  之所以放 `/app/models` 而非 `/root/.moss/models`：`deploy/docker-compose.yml` 把宿主机 `./.moss` 整个挂到 `/root/.moss`，会**遮挡**镜像里烤进 `/root/.moss` 的任何内容；`/app` 不被挂载，所以模型必须烤到 `/app` 下。
- 运行时所需的 external 依赖（`@xenova/transformers` + `onnxruntime-node` + `sharp`）通过 `deploy/runtime-deps.package.json` 装进镜像的 `/app/node_modules`，否则 `import('@xenova/transformers')` 抛 `MODULE_NOT_FOUND`，embedder 会静默降级 grep-only。

模型来源：模型 zip **随仓库提供**，存放在 `deploy/models/Xenova.zip`（经 **git-lfs** 跟踪，见 `.gitattributes`）。zip 顶层是 `Xenova/multilingual-e5-small/...`。两个 Dockerfile 各有一个 `model-stage` 解压阶段，在镜像内解压并剥掉 Mac junk（`__MACOSX`/`.DS_Store`/`.cache`），只把干净的模型树 COPY 进 runtime stage（zip 与 unzip 工具都不进最终镜像）。

- **本地自包含构建**（`deploy/build-server-local.sh` → `server.Dockerfile.local`）：直接用仓库里的 `deploy/models/Xenova.zip`，无需任何宿主机预置。
  ```bash
  git lfs pull            # 确保 LFS 模型对象已落地（克隆后首次需要）
  deploy/build-server-local.sh
  ```
  若该 zip 缺失或仍是未解析的 LFS 指针（~130B），脚本会提前告警。
- **CI 产物构建**（`deploy/server.Dockerfile.local`，由 `.github/workflows/build-release.yml` 第 6 步构建）：CI 的 `actions/checkout` 已设 `lfs: true` 拉取真模型，`model-stage` 解压后烤进 `/app/models`。无需任何 build-arg 或外部下载地址。

> 更新模型：替换 `deploy/models/Xenova.zip` 后 `git add` 提交即可（LFS 会存新版本）。

## 3. 私有化离线预置（仍走挂载方式时）

若不烤进镜像、仍想用挂载预置（`./.moss/models` → 容器 `/root/.moss/models`），从一台能联网的机器把整个模型目录 rsync 到 **docker-compose 同级的 `./.moss`** 即可：

```bash
# 在能联网的机器上一次性预热
mkdir -p ~/.moss/models
MOSS_HOME=~/.moss bun run bin/moss-server.mjs &  # 第一次启动会自动下载

# 等日志看到 "[wikiIndex] embedder ready" 后停服

# rsync 到内网机（目标为 compose 同级的 ./.moss，即被挂载到 /root/.moss 的宿主机目录）
rsync -av ~/.moss/models/Xenova/multilingual-e5-small/ \
  user@internal-host:/path/to/compose-dir/.moss/models/Xenova/multilingual-e5-small/
```

预置后内网机启动不会再触网。

### 必需文件列表

`~/.moss/models/Xenova/multilingual-e5-small/` 下需要：

```text
tokenizer.json
tokenizer_config.json
config.json
special_tokens_map.json
onnx/model_quantized.onnx
```

只要 `onnx/model_quantized.onnx` 存在，embedder 加载就**不会触发下载**。

## 4. 通过镜像源加速下载

若使用 HuggingFace 镜像（如 `hf-mirror.com`），可以在 `server.json` 或环境变量里配置：

**方式 A：server.json**
```json
{
  "wikiIndex": {
    "modelMirror": "https://hf-mirror.com"
  }
}
```

**方式 B：环境变量（优先级高）**
```bash
export MOSS_MODEL_MIRROR="https://hf-mirror.com"
moss-server
```

## 5. 一键关闭向量索引

如果不需要语义检索，或想在调试时强制走 grep：

```bash
MOSS_WIKI_INDEX_DISABLED=1 moss-server
```

或在 `server.json` 设置 `wikiIndex.enabled: false`。两种方式都会让 wiki 构建跳过向量产物，查询路径走纯 grep，行为与升级前一致。

## 6. 替换嵌入模型

在 `server.json` 中改 `wikiIndex.modelId`：

```json
{
  "wikiIndex": {
    "modelId": "Xenova/bge-small-zh-v1.5"
  }
}
```

候选：

| 模型 ID | 维度 | 体积 | 特点 |
|---|---|---|---|
| `Xenova/multilingual-e5-small` (默认) | 384 | ~120MB | 中英多语 |
| `Xenova/bge-small-zh-v1.5` | 512 | ~100MB | 纯中文强 |
| `Xenova/bge-m3` | 1024 | ~600MB | 多语+长文本，质量最好 |

切换后**所有 wiki 都需要重新构建**（旧 wiki 的向量维度跟新模型不匹配，查询时会被 `loadIndex` 的尺寸校验丢弃，自动降级 grep）。

## 7. 老 wiki 兼容

升级到本版本前构建的 wiki **不会自动补建向量索引**。它们只有 `WIKI.md` + `chunk-*.md`，没有 `_moss_index.*` 产物。Agent 查询时自动走 grep-only，无任何错误。

要让老 wiki 也支持语义检索，在文档中心点击"重新构建"即可——构建会经过 Stage 4.5（向量索引）。

## 8. 运维检查清单

构建一份 wiki 后确认产物：

```bash
ls -la ~/.moss/wikis/<wikiId>/
# 期望看到 _moss_index.bin 和 _moss_index.jsonl
stat ~/.moss/wikis/<wikiId>/_moss_index.bin
# size 应该等于 count * 384 * 4 字节（count 在 _moss_index.jsonl 第一行 manifest）
head -1 ~/.moss/wikis/<wikiId>/_moss_index.jsonl | jq
```

检索效果验证（query 词跟原文不完全一致更能体现 vec 价值）：

```bash
curl -H "Authorization: Bearer $SESSION_TOKEN" \
  "http://localhost:43127/api/v1/agent/wikis/<wikiId>/search?q=返厂物流单"
# 返回 matches 里如果包含 [vec] 前缀的行，说明 hybrid 走通了
```

构建过程的 log 关键词：

```text
[WikiJobExecutor] vector index built for wiki=<id>: <N> passages    # 成功
[WikiJobExecutor] vector index skipped for wiki=<id>: embedder-unavailable  # 模型缺失（降级）
[WikiJobExecutor] vector index skipped for wiki=<id>: embed-failed  # 嵌入异常（降级）
[wikiIndex] embedder ready: model=Xenova/multilingual-e5-small dim=384  # 首次加载成功
```

## 9. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 启动后日志无 `embedder ready`，wiki 重建后没有 `_moss_index.*` | 模型未下载且无外网 | 配 `MOSS_MODEL_MIRROR` 或预置模型 |
| Search 永远不返回 `[vec]` 行 | feature flag 关闭 / 索引文件不存在 / 维度不匹配 | 查 `server.json` 和 wiki 目录；重新构建 |
| Build 卡在"Agent 正在生成内容" 30 分钟超时 | LLM 段，跟向量索引无关 | 见 `docs/document-center-wiki-flow.md` |
| 启动慢（首次 +2-5s） | embedder 单例首次加载 ONNX session | 正常，后续请求复用 |
| CPU 飙高 | 向量构建期 + 高并发 search | search 内置并发上限=2；构建可调 `maxPassagesPerWiki` 限制 |

## 10. 配置参考

`server.json` 完整字段：

```json
{
  "wikiIndex": {
    "enabled": true,
    "modelId": "Xenova/multilingual-e5-small",
    "modelMirror": "https://hf-mirror.com",
    "maxPassagesPerWiki": 20000,
    "topKVector": 50
  }
}
```

- `enabled`：feature flag，env `MOSS_WIKI_INDEX_DISABLED=1` 覆盖为 false。
- `modelId`：transformers.js 兼容的 HF 仓库 ID。
- `modelMirror`：HF endpoint 镜像；env `MOSS_MODEL_MIRROR` 覆盖。
- `maxPassagesPerWiki`：单 wiki 索引段落上限，超出截断（防御性兜底）。
- `topKVector`：向量召回 top-K，融合前的候选数。
