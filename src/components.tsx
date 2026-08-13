import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, authUrl, type Media, type Work } from "./api";

// Loads a protected poster/artwork as a blob URL so the auth token stays in the
// Authorization header instead of leaking into the image URL (history/logs).
export function PosterBg({ path, className, children }: { path?: string; className?: string; children?: React.ReactNode }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!path) return;
    let active = true;
    authUrl(path).then((u) => { if (active) setUrl(u); });
    return () => { active = false; };
  }, [path]);
  return <div className={className} style={url ? { backgroundImage: `url(${url})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>{children}</div>;
}

export function LibraryBack({ kind }: { kind?: "movie" | "show" }) {
  const navigate = useNavigate();
  const fallback = kind === "show" ? "/shows" : kind === "movie" ? "/movies" : "/";
  return <button type="button" className="back" onClick={() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(fallback);
  }}>← 返回片库</button>;
}

export function useCloseOnOutside(menuId: number | undefined, setMenuId: React.Dispatch<React.SetStateAction<number | undefined>>, selector: string) {
  useEffect(() => {
    if (menuId === undefined) return;
    const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest(selector)) setMenuId(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuId(undefined); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menuId, selector, setMenuId]);
}

export function WorkSection({ title, items, loading, refreshingId, onRefresh, total, loadingMore, onLoadMore }: { title: string; items: Work[]; loading?: boolean; refreshingId?: number; onRefresh?: (id: number) => void; total?: number; loadingMore?: boolean; onLoadMore?: () => void }) {
  const [menuId, setMenuId] = useState<number>();
  const [manageWork, setManageWork] = useState<Work>();
  useCloseOnOutside(menuId, setMenuId, ".media-menu, .media-more");
  return <section className="media-section">
    <div className="section-heading"><h2>{title}</h2><span>{total !== undefined ? `${items.length} / ${total} 部` : `${items.length} 部`}</span></div>
    {loading ? <div className="empty">正在整理作品...</div> : items.length === 0 ? <div className="empty"><strong>银幕还没有亮起</strong><span>前往“设置”扫描你的影视目录。</span><Link className="text-link" to="/admin">打开设置 →</Link></div> : <div className="poster-grid">{items.map((item, index) => <article className="media-card" key={item.id}><Link className="poster-card" to={`/work/${item.id}`}><PosterBg path={item.poster_path} className={`poster art-${index % 6}`}><span>{item.kind === "show" ? "SERIES" : "FILM"}</span><b>{item.poster_path ? "" : item.title.slice(0, 1)}</b></PosterBg><h3>{item.title}</h3><p>{item.year || "未匹配年份"} · {item.kind === "show" ? `${item.season_count} 季` : `${item.file_count} 个版本`}</p></Link><button className="media-more" type="button" aria-label="更多操作" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setMenuId(menuId === item.id ? undefined : item.id); }}>⋯</button>{menuId === item.id && <div className="media-menu"><button type="button" disabled={refreshingId === item.id} onClick={() => { setMenuId(undefined); onRefresh?.(item.id); }}>{refreshingId === item.id ? "刮削中..." : "重新刮削"}</button><button type="button" onClick={() => { setMenuId(undefined); setManageWork(item); }}>编辑文件信息</button><button type="button" className="danger-text" onClick={() => { setMenuId(undefined); setManageWork(item); }}>删除文件</button></div>}</article>)}</div>}
    {manageWork && <WorkFilesDialog work={manageWork} onClose={() => setManageWork(undefined)} />}
    {!loading && total !== undefined && items.length < total && <div className="load-more-row"><button className="secondary" type="button" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "加载中..." : "加载更多"}</button></div>}
  </section>;
}

export function WorkFilesDialog({ work, onClose }: { work: Work; onClose: () => void }) {
  const [data, setData] = useState<{ work: Work; media: Media[] }>();
  const [editing, setEditing] = useState<Media>();
  const [undo, setUndo] = useState<{ message: string; onUndo: () => void }>();
  useEffect(() => { api<{ work: Work; media: Media[] }>(`/works/${work.id}`).then(setData); }, [work.id]);
  if (!data) return <div className="drawer-mask" onClick={onClose}><div className="drawer" onClick={(e) => e.stopPropagation()}><div className="empty">正在读取文件...</div></div></div>;
  async function remove(item: Media) {
    if (!window.confirm(`确定将「${item.path.split("/").pop()}」移到回收站吗？可随时恢复。`)) return;
    try {
      await api(`/media/${item.id}`, { method: "DELETE" });
      setData((current) => current ? { ...current, media: current.media.filter((file) => file.id !== item.id) } : current);
      setUndo({ message: "已移至回收站", onUndo: () => { void api(`/media/${item.id}/restore`, { method: "POST" }).catch(() => {}); api<{ work: Work; media: Media[] }>(`/works/${work.id}`).then(setData); } });
    }
    catch (error) { window.alert((error as Error).message); }
  }
  return <div className="drawer-mask" onClick={onClose}><div className="drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">MEDIA FILES</span><h2>{work.title}</h2></div><button type="button" className="icon-close" aria-label="关闭" onClick={onClose}>×</button></div><p className="drawer-desc">这里管理该作品下的全部媒体文件。编辑会同步修改实际文件信息，删除会移至回收站。</p>{undo && <div className="admin-toast">{undo.message}<button type="button" onClick={undo.onUndo}>撤销</button><button type="button" aria-label="关闭" onClick={() => setUndo(undefined)}>×</button></div>}<div className="work-files-list">{data.media.length === 0 ? <div className="empty">没有可用文件</div> : data.media.map((item) => <div className="work-file-row" key={item.id}><div><strong>{item.kind === "show" && item.season ? `S${String(item.season).padStart(2, "0")}E${String(item.episode || 0).padStart(2, "0")}` : item.title}</strong><small>{item.path.split("/").pop()}</small></div><div><button className="ghost" type="button" onClick={() => setEditing(item)}>编辑</button><button className="ghost danger" type="button" onClick={() => void remove(item)}>删除</button></div></div>)}</div><div className="drawer-actions"><button type="button" className="secondary" onClick={onClose}>关闭</button></div>{editing && <MediaEditDialog item={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onClose(); }} />}</div></div>;
}

export function MediaSection({ title, items, loading, wide = false, emptyText }: { title: string; items: Media[]; loading?: boolean; wide?: boolean; emptyText?: string }) {
  const [menuId, setMenuId] = useState<number>();
  const [editing, setEditing] = useState<Media>();
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [refreshingWorkId, setRefreshingWorkId] = useState<number>();
  const [undo, setUndo] = useState<{ message: string; onUndo: () => void }>();
  const undoRef = useRef<number | undefined>(undefined);
  const visible = items.filter((item) => !removed.has(item.id));
  function showUndo(message: string, onUndo: () => void) {
    if (undoRef.current) window.clearTimeout(undoRef.current);
    setUndo({ message, onUndo });
    undoRef.current = window.setTimeout(() => setUndo(undefined), 6000);
  }
  useEffect(() => () => { if (undoRef.current) window.clearTimeout(undoRef.current); }, []);
  useCloseOnOutside(menuId, setMenuId, ".media-menu, .media-more");
  async function remove(item: Media) {
    if (!window.confirm(`确定将「${item.title}」移到回收站吗？可随时恢复。`)) return;
    try {
      await api(`/media/${item.id}`, { method: "DELETE" });
      setRemoved((current) => new Set(current).add(item.id));
      setMenuId(undefined);
      showUndo("已移至回收站", () => {
        void api(`/media/${item.id}/restore`, { method: "POST" }).catch(() => {});
        setRemoved((current) => { const next = new Set(current); next.delete(item.id); return next; });
      });
    } catch (error) {
      window.alert((error as Error).message);
      setMenuId(undefined);
    }
  }
  async function removeFromList(item: Media) {
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
  async function refresh(item: Media) {
    if (!item.work_id || refreshingWorkId) return;
    setRefreshingWorkId(item.work_id);
    try { await api(`/works/${item.work_id}/metadata/refresh`, { method: "POST" }); window.location.reload(); }
    catch (error) { window.alert((error as Error).message); setRefreshingWorkId(undefined); }
  }
  async function toggleDone(item: Media) {
    const duration = item.duration ?? item.progress_duration ?? 0;
    const completed = Boolean(item.completed);
    try {
      await api(`/media/${item.id}/progress`, { method: "PUT", body: JSON.stringify({ position: completed ? 0 : duration, duration, completed: !completed }) });
      // Hide the card either way: marking done drops it from 最近播放, and
      // unwatching resets its progress so it no longer shows as partially seen.
      setRemoved((current) => new Set(current).add(item.id));
      setMenuId(undefined);
      showUndo(completed ? "已取消完成标记" : "已标记为完成", () => {
        void api(`/media/${item.id}/progress`, { method: "PUT", body: JSON.stringify({ position: completed ? duration : 0, duration, completed }) }).catch(() => {});
        setRemoved((current) => { const next = new Set(current); next.delete(item.id); return next; });
      });
    } catch (error) {
      window.alert((error as Error).message);
      setMenuId(undefined);
    }
  }
  return <section className="media-section">
    <div className="section-heading"><h2>{title}</h2><span>{visible.length} 部</span></div>
    {undo && <div className="admin-toast">{undo.message}<button type="button" onClick={undo.onUndo}>撤销</button><button type="button" aria-label="关闭" onClick={() => setUndo(undefined)}>×</button></div>}
    {loading ? <div className="empty">正在翻阅片库...</div> : visible.length === 0 ? (emptyText ? <div className="empty muted">{emptyText}</div> : null) : <div className={wide ? "continue-grid" : "poster-grid"}>{visible.map((item, index) => {
      const percent = item.position && item.progress_duration ? Math.min(100, (item.position / item.progress_duration) * 100) : 0;
      const poster = item.work_poster;
      return <article className="media-card" key={item.id}><Link className="poster-card" to={`/watch/${item.id}`}>
        <PosterBg path={poster} className={`poster art-${index % 6}`}>
          <span>{item.kind === "show" ? "SERIES" : "FILM"}</span>
          <b>{poster ? "" : item.title.slice(0, 1)}</b>
          {percent > 0 && <i style={{ width: `${percent}%` }} />}
        </PosterBg>
        <h3>{item.title}</h3>
        <p>{item.kind === "show" && item.season ? `第 ${item.season} 季 · 第 ${item.episode} 集` : item.source_name || item.container?.toUpperCase() || "视频"}{percent > 0 ? ` · 已看 ${Math.round(percent)}%` : ""}</p>
      </Link><button className="media-more" type="button" aria-label="更多操作" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setMenuId(menuId === item.id ? undefined : item.id); }}>⋯</button>{menuId === item.id && <div className="media-menu"><button type="button" onClick={() => void toggleDone(item)}>{item.completed ? "取消已完成" : "标记为已完成"}</button><button type="button" disabled={!item.work_id || refreshingWorkId === item.work_id} onClick={() => void refresh(item)}>{refreshingWorkId === item.work_id ? "刮削中..." : "重新刮削"}</button><button type="button" onClick={() => { setEditing(item); setMenuId(undefined); }}>编辑文件信息</button><button type="button" onClick={() => void removeFromList(item)}>移除</button><button type="button" className="danger-text" onClick={() => void remove(item)}>删除文件</button></div>}</article>;
    })}</div>}
    {editing && <MediaEditDialog item={editing} onClose={() => setEditing(undefined)} onSaved={() => setEditing(undefined)} />}
  </section>;
}

function MediaEditDialog({ item, onClose, onSaved }: { item: Media; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: item.path.split("/").pop() || "", title: item.title, season: item.season ? String(item.season) : "", episode: item.episode ? String(item.episode) : "" });
  const [error, setError] = useState("");
  async function save(event: React.FormEvent) { event.preventDefault(); try { await api(`/media/${item.id}`, { method: "PUT", body: JSON.stringify(form) }); onSaved(); window.location.reload(); } catch (e) { setError((e as Error).message); } }
  return <div className="drawer-mask" onClick={onClose}><form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={save}><div className="drawer-head"><div><span className="eyebrow">MEDIA FILE</span><h2>修改文件信息</h2></div><button type="button" className="icon-close" aria-label="关闭" onClick={onClose}>×</button></div><p className="drawer-desc">修改文件名会同步重命名实际媒体文件，原始路径目录保持不变。</p><label>原始文件名<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label><label>显示标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label><div className="media-edit-row"><label>季<input type="number" min="1" value={form.season} onChange={(e) => setForm({ ...form, season: e.target.value })} /></label><label>集<input type="number" min="1" value={form.episode} onChange={(e) => setForm({ ...form, episode: e.target.value })} /></label></div>{error && <p className="error">{error}</p>}<div className="drawer-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" type="submit">保存修改</button></div></form></div>;
}
