import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createAgentCatalogApi,
  type CatalogRunEvent,
} from "@/lib/api/agent-catalog";
import { externalAgentError } from "@/lib/external-agent-errors";
export function ExternalRunEvents({
  agent,
  task,
}: {
  agent: string;
  task: string;
}) {
  const abort = useRef(new AbortController()),
    pending = useRef(false);
  const [events, setEvents] = useState<CatalogRunEvent[]>([]),
    [cursor, setCursor] = useState(0),
    [more, setMore] = useState(false),
    [loaded, setLoaded] = useState(false),
    [compacted, setCompacted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const current = new AbortController();
    abort.current = current;
    return () => current.abort();
  }, [agent, task]);
  async function load(after = 0) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const current = abort.current;
    try {
      const page = await createAgentCatalogApi(() => current.signal).runEvents(
        agent,
        task,
        after,
      );
      if (!current.signal.aborted) {
        setEvents((rows) => (after ? [...rows, ...page.events] : page.events));
        setCursor(page.next_cursor);
        setMore(page.has_more);
        setCompacted((c) => (after ? c || page.compacted : page.compacted));
        setLoaded(true);
      }
    } catch (e) {
      if (!current.signal.aborted) setError(externalAgentError(e));
    } finally {
      pending.current = false;
      if (!current.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="规范化事件" className="mt-3 space-y-2 border-t pt-3">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void load()}
      >
        {loaded ? "刷新规范化事件" : "查看规范化事件"}
      </Button>
      <p className="text-xs text-muted-foreground">
        展示事件序号、状态和错误码，不含用户输入输出；不代表提供方完整 Trace
        或可重放记录。
      </p>
      {error && <p role="alert">{error}</p>}
      {compacted && (
        <p>部分早期事件已压缩或不在保留范围，请结合任务最终状态核对。</p>
      )}
      {loaded && !events.length && <p>暂无保留的事件。</p>}
      <ol className="space-y-1">
        {events.map((e) => (
          <li key={e.sequence} className="break-all">
            #{e.sequence} · {new Date(e.at).toLocaleString()} · {e.type} ·{" "}
            {e.status ?? "—"}
            {e.error_code ? ` · ${e.error_code}` : ""}
          </li>
        ))}
      </ol>
      {more && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void load(cursor)}
        >
          加载更多事件
        </Button>
      )}
    </section>
  );
}
