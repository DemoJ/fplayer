import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type BrowseResult, type Media, type Source, type UpNext } from "../api";
import { MediaSection, PosterBg, useCloseOnOutside } from "../components";

function UpNextSection({ items, loading }: { items: UpNext[]; loading: boolean }) {
  const [menuId, setMenuId] = useState<number>();
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [undo, setUndo] = useState<{ message: string; onUndo: () => void }>();
  const undoRef = useRef<number | undefined>(undefined);
  const visible = items.filter((item) => !removed.has(item.id));
  useCloseOnOutside(menuId, setMenuId, ".media-menu, .media-more");
  function showUndo(message: string, onUndo: () => void) {
    if (undoRef.current) window.clearTimeout(undoRef.current);
    setUndo({ message, onUndo });
    undoRef.current = window.setTimeout(() => setUndo(undefined), 6000);
  }
  useEffect(() => () => { if (undoRef.current) window.clearTimeout(undoRef.current); }, []);
  async function removeFromList(item: UpNext) {
    setMenuId(undefined);
    setRemoved((current) => new Set(current).add(item.id));
    try {
      const result = await api<{ removed: Array<{ media_id: number; position: number; duration: number }> }>(`/media/${item.id}/remove-from-list`, { method: "POST" });
      showUndo("已从列表中移除（重新观看后会再次出现）", () => {
        void Promise.all((result.removed || []).map((r) => api(`/media/${r.media_id}/progress`, { method: "PUT", body: JSON.stringify({ position: r.position, duration: r.duration }) }))).catch(() => {});
        setRemoved((current) => { const next = new Set(current); next.delete(item.id); return next; });
      });
    } catch (error) {
      window.alert((error as Error).message);
      setRemoved((current) => { const next = new Set(current); next.delete(item.id); return next; });
    }
  }
  async function finish(item: UpNext) {
    const duration = item.duration ?? 0;
    setMenuId(undefined);
    try { await api(`/media/${item.id}/progress`, { method: "PUT", body: JSON.stringify({ position: duration, duration }) }); window.location.reload(); }
    catch (error) { window.alert((error as Error).message); }
  }
  async function remove(item: UpNext) {
    if (!window.confirm(`确定将「${item.work_title} S${pad(item.season)}E${pad(item.episode)}」移到回收站吗？可随时恢复。`)) return;
    setMenuId(undefined);
    try { await api(`/media/${item.id}`, { method: "DELETE" }); window.location.reload(); }
    catch (error) { window.alert((error as Error).message); }
  }
  if (!loading && visible.length === 0) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return <section className="media-section">
    <div className="section-heading"><h2>接下来</h2><span>{visible.length} 部</span></div>
    {undo && <div className="admin-toast">{undo.message}<button type="button" onClick={undo.onUndo}>撤销</button><button type="button" aria-label="关闭" onClick={() => setUndo(undefined)}>×</button></div>}
    {loading ? <div className="empty">正在整理接下来...</div> : <div className="continue-grid">{visible.map((item, index) => <article className="media-card" key={item.id}><Link className="poster-card" to={`/watch/${item.id}`}><PosterBg path={item.work_poster} className={`poster art-${index % 6}`}><span>SERIES</span><b>{item.work_poster ? "" : item.work_title.slice(0, 1)}</b></PosterBg><h3>{item.work_title}</h3><p>看完 S{pad(item.from_season)}E{pad(item.from_episode)} · 下一集 S{pad(item.season)}E{pad(item.episode)}</p></Link><button className="media-more" type="button" aria-label="更多操作" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setMenuId(menuId === item.id ? undefined : item.id); }}>⋯</button>{menuId === item.id && <div className="media-menu"><button type="button" onClick={() => void finish(item)}>标记为已完成</button><button type="button" onClick={() => void removeFromList(item)}>移除</button><button type="button" className="danger-text" onClick={() => void remove(item)}>删除文件</button></div>}</article>)}</div>}
  </section>;
}

export function Home() {
  const [sources, setSources] = useState<Source[]>([]);
  const [continued, setContinued] = useState<Media[]>([]);
  const [upNext, setUpNext] = useState<UpNext[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    setLoading(true); setLoadError("");
    Promise.all([
      api<BrowseResult>("/browse").then((data) => setSources(data.sources || [])).catch((e) => { setSources([]); setLoadError((e as Error).message); }),
      api<Media[]>("/continue?limit=12").then(setContinued).catch(() => setContinued([])),
      api<UpNext[]>("/up-next?limit=10").then(setUpNext).catch(() => setUpNext([])),
    ]).finally(() => setLoading(false));
  }, []);
  return <main>
    <header className="topbar"><div><span className="eyebrow">PRIVATE CINEMA</span><h1>今晚，看点什么？</h1></div></header>
    <MediaSection title="最近播放" items={continued} wide emptyText="还没有未看完的内容" />
    <UpNextSection items={upNext} loading={loading} />
    <section className="media-section">
      <div className="section-heading"><h2>我的媒体</h2><span>{sources.length} 个</span></div>
      {loading ? <div className="empty">正在载入媒体源...</div> : loadError ? <div className="empty"><strong>媒体源加载失败</strong><span>{loadError}</span></div> : sources.length === 0 ? <div className="empty"><strong>还没有媒体源</strong><span>前往“设置”添加 NAS 或 WebDAV。</span><Link className="text-link" to="/admin">打开设置 →</Link></div> : <div className="source-grid">{sources.map((source, index) => <Link className="source-tile" key={source.id} to={`/browse/${source.id}`}><div className={`source-cover art-${index % 6}`}><span className="source-type">{source.type === "webdav" ? "WebDAV" : "NAS"}</span><b className="source-mark">{source.type === "webdav" ? "W" : "N"}</b><span className="source-count">{source.file_count || 0}<small>个文件</small></span></div><div className="source-meta"><h3>{source.name}</h3><small>{source.base_path}</small></div></Link>)}</div>}
    </section>
  </main>;
}
