import { useEffect, useRef, useState } from "react";
import { api, type Work } from "../api";
import { WorkSection } from "../components";

const PAGE_SIZE = 60;

export function Library({ kind }: { kind: "movie" | "show" }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Work[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshingId, setRefreshingId] = useState<number>();
  const [message, setMessage] = useState("");
  const reqIdRef = useRef(0);
  useEffect(() => {
    setLoading(true);
    const reqId = ++reqIdRef.current;
    const handle = window.setTimeout(() => {
      api<{ items: Work[]; total: number }>(`/works?kind=${kind}&q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=0`).then((data) => {
        // Only keep the result of the latest request to avoid stale overwrites.
        if (reqId === reqIdRef.current) { setItems(data.items); setTotal(data.total); }
      }).catch(() => {}).finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [kind, query]);
  async function loadMore() {
    if (loadingMore || loading || items.length >= total) return;
    setLoadingMore(true);
    try {
      const data = await api<{ items: Work[]; total: number }>(`/works?kind=${kind}&q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}&offset=${items.length}`);
      setItems((current) => [...current, ...data.items]);
      setTotal(data.total);
    } catch {
      // keep the button clickable for a retry
    } finally {
      setLoadingMore(false);
    }
  }
  async function refreshItem(id: number) {
    setRefreshingId(id); setMessage("");
    try {
      const result = await api<{ work: Work }>(`/works/${id}/metadata/refresh`, { method: "POST" });
      setItems((current) => current.map((item) => item.id === id ? { ...item, ...result.work } : item));
      setMessage("重新刮削完成");
    } catch (error) { setMessage((error as Error).message); }
    finally { setRefreshingId(undefined); }
  }
  return <main>
    <header className="topbar">
      <div><span className="eyebrow">PRIVATE CINEMA</span><h1>{kind === "movie" ? "电影" : "剧集"}</h1></div>
      <label className="search">⌕<input placeholder="搜索片名" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
    </header>
    {message && <div className="admin-toast">{message}<button type="button" aria-label="关闭" onClick={() => setMessage("")}>×</button></div>}
    <WorkSection title={`全部${kind === "movie" ? "电影" : "剧集"}`} items={items} loading={loading} refreshingId={refreshingId} onRefresh={refreshItem} total={total} loadingMore={loadingMore} onLoadMore={() => void loadMore()} />
  </main>;
}
