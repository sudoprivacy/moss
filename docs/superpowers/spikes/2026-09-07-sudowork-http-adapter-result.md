# Sudowork HTTP Adapter Spike 结论

## 结论

Moss 现有 `node:http` Server 可以在不改端口、不抢占 WebSocket upgrade 的前提下，按可信 `Host` 将请求交给 Hono。Spike 使用 `hono@4.12.9` 和 `@hono/node-server@1.19.12`，通过 `getRequestListener(app.fetch)` 适配 `IncomingMessage` 与 `ServerResponse`。

## 已验证行为

- 相同 `/api/v1/auth/login` 按 Host 分别进入 Sudowork Hono 或 Moss 原生处理器。
- JSON、`application/x-www-form-urlencoded`、multipart 文件上传均保持原请求体，分流前不消费流。
- CORS 预检、302、错误状态与 JSON 响应保持 Hono 行为。
- SSE 能持续输出，客户端断开后 Hono 能观察 abort 并结束生产循环。
- `/healthz` 和未知 Host 继续进入 Moss；相似恶意域名不会命中 Sudowork。
- `upgrade` 事件由 `node:http` Server 的既有监听器处理，不进入 Hono request listener。

## 生产约束

1. Host 判断必须发生在 CORS、认证和读取请求体之前。
2. 只信任反向代理保留或重写后的标准 `Host`；不要直接信任公网客户端提供的 `X-Forwarded-Host`。
3. 生产配置使用精确主机名白名单，比较前只做小写和端口剥离；缺失、畸形、多值 Host 回落 Moss。
4. 请求体只有最终选中的处理器拥有，分流层不得读取、缓存或重放。
5. WebSocket 继续绑定 Server 的 `upgrade` 事件，不能由兼容 HTTP Adapter 兜底。

## 建议最小接口

```ts
interface SudoworkHostDispatchOptions {
  sudoworkHosts: readonly string[]
  sudoworkFetch: FetchCallback
  mossHandler: RequestListener
}

function createHostDispatch(options: SudoworkHostDispatchOptions): RequestListener
```

Spike 代码仅用于证明运行时边界。正式实现应放入 Moss Server 的 HTTP 组合层，并由生产配置提供 Host 白名单，不能从 `spikes/` 导入。
