import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, authUrl, clearToken, getToken, setOnUnauthorized, setToken, type BrowseResult, type Media, type ScanJob, type Source, type UpNext, type User, type Work } from "./api";

function Auth({ initialized, onLogin, onSetupDone }: { initialized: boolean; onLogin: (user: User) => void; onSetupDone: () => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try {
      if (!initialized) { await api("/setup", { method: "POST", body: JSON.stringify({ username, password }) }); onSetupDone(); }
      const result = await api<{ token: string; user: User }>("/login", { method: "POST", body: JSON.stringify({ username, password }) });
      setToken(result.token); onLogin(result.user);
    } catch (e) { setError((e as Error).message); }
  }
  return <main className="auth-page"><section className="auth-copy"><span className="eyebrow">YOUR SCREEN. YOUR STORAGE.</span><h1>让收藏，<br />重新开场。</h1><p>连接 NAS 与 WebDAV，在任何浏览器中进入你的私人放映室。</p></section><form className="auth-card" onSubmit={submit}><div className="brand-mark">F</div><div><span className="eyebrow">FPLAYER</span><h2>{initialized ? "欢迎回来" : "创建管理员"}</h2></div><label>用户名<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required /></label><label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={initialized ? undefined : 8} required /></label>{error && <p className="error">{error}</p>}<button className="primary" type="submit">{initialized ? "进入媒体库" : "创建并进入"}</button><small>{initialized ? "使用你的本地账户登录" : "首个账户将成为系统管理员"}</small></form></main>;
}

function Layout({ user, logout }: { user: User; logout: () => void }) {
  const location = useLocation(); const [jobs, setJobs] = useState<ScanJob[]>([]);
  const cinema = location.pathname.startsWith("/watch/");
  useEffect(() => {
    let active = true; let timer = 0;
    const refresh = () => api<ScanJob[]>("/scans").then((rows) => { if (active) setJobs(rows); }).catch(() => {});
    refresh();
    // Poll only while there are active jobs; stop the interval once idle.
    // Check current state from a ref to avoid retriggering this effect on every
    // setJobs, which would cause an infinite request loop.
    timer = window.setInterval(() => {
      setJobs((current) => {
        const hasActive = current.some((job) => ["queued", "running"].includes(job.status));
        if (hasActive) refresh();
        return current;
      });
    }, 2000);
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, []);
  async function dismiss(job: ScanJob) { await api(`/scans/${job.id}/acknowledge`, { method: "POST" }); setJobs((current) => current.filter((item) => item.id !== job.id)); }
  const finished = jobs.filter((job) => ["completed", "failed", "cancelled"].includes(job.status));
  return <div className={`shell ${cinema ? "cinema" : ""}`}><aside><Link className="logo" to="/"><span>F</span> FPLAYER</Link><nav><Link className={location.pathname === "/" ? "active" : ""} to="/" aria-label="首页">⌂ <span>首页</span></Link><Link className={location.pathname.startsWith("/movies") ? "active" : ""} to="/movies" aria-label="电影">◫ <span>电影</span></Link><Link className={location.pathname.startsWith("/shows") ? "active" : ""} to="/shows" aria-label="剧集">▤ <span>剧集</span></Link><Link className={location.pathname.startsWith("/admin") ? "active" : ""} to="/admin" aria-label="媒体源">⚙ <span>媒体源</span></Link></nav><div className="account"><div className="avatar">{user.username[0].toUpperCase()}</div><div><strong>{user.username}</strong><button onClick={logout}>退出登录</button></div></div></aside><div className="content"><Routes><Route path="/" element={<Home />} /><Route path="/movies" element={<Library kind="movie" />} /><Route path="/shows" element={<Library kind="show" />} /><Route path="/browse" element={<BrowseView />} /><Route path="/browse/:sourceId" element={<BrowseView />} /><Route path="/work/:id" element={<WorkDetail />} /><Route path="/media/:id" element={<Detail />} /><Route path="/watch/:id" element={<PlayerRoute />} /><Route path="/admin" element={<SourceAdmin jobs={jobs} refreshJobs={(rows) => setJobs(rows)} />} /></Routes></div>{finished.length > 0 && <div className="notifications">{finished.map((job) => <article className={`toast ${job.status}`} key={job.id}><div><strong>{job.source_name}：{job.status === "completed" ? "扫描完成" : job.status === "cancelled" ? "扫描已停止" : "扫描失败"}</strong><p>{job.status === "completed" ? `共发现并更新 ${job.result_count || 0} 个媒体文件` : job.error}</p></div><button aria-label="关闭" onClick={() => dismiss(job)}>×</button></article>)}</div>}</div>;
}

// Loads a protected poster/artwork as a blob URL so the auth token stays in the
// Authorization header instead of leaking into the image URL (history/logs).
function PosterBg({ path, className, children }: { path?: string; className?: string; children?: React.ReactNode }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!path) return;
    let active = true;
    authUrl(path).then((u) => { if (active) setUrl(u); });
    return () => { active = false; };
  }, [path]);
  return <div className={className} style={url ? { backgroundImage: `url(${url})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>{children}</div>;
}

function LibraryBack({ kind }: { kind?: "movie" | "show" }) {
  const navigate = useNavigate();
  const fallback = kind === "show" ? "/shows" : kind === "movie" ? "/movies" : "/";
  return <button type="button" className="back" onClick={() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(fallback);
  }}>← 返回片库</button>;
}

function Home() {
  const [sources, setSources] = useState<Source[]>([]);
  const [continued, setContinued] = useState<Media[]>([]);
  const [recent, setRecent] = useState<Media[]>([]);
  const [upNext, setUpNext] = useState<UpNext[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    setLoading(true); setLoadError("");
    Promise.all([
      api<BrowseResult>("/browse").then((data) => setSources(data.sources || [])).catch((e) => { setSources([]); setLoadError((e as Error).message); }),
      api<Media[]>("/continue?limit=12").then(setContinued).catch(() => setContinued([])),
      api<Media[]>("/recent?limit=10").then(setRecent).catch(() => setRecent([])),
      api<UpNext[]>("/up-next?limit=10").then(setUpNext).catch(() => setUpNext([])),
    ]).finally(() => setLoading(false));
  }, []);
  return <main>
    <header className="topbar"><div><span className="eyebrow">PRIVATE CINEMA</span><h1>今晚，看点什么？</h1></div></header>
    <section className="media-section">
      <div className="section-heading"><h2>我的媒体</h2><span>{sources.length} 个</span></div>
      {loading ? <div className="empty">正在载入媒体源...</div> : loadError ? <div className="empty"><strong>媒体源加载失败</strong><span>{loadError}</span></div> : sources.length === 0 ? <div className="empty"><strong>还没有媒体源</strong><span>前往“媒体源”添加 NAS 或 WebDAV。</span><Link className="text-link" to="/admin">添加媒体源 →</Link></div> : <div className="source-grid">{sources.map((source, index) => <Link className="source-tile" key={source.id} to={`/browse/${source.id}`}><div className={`source-cover art-${index % 6}`}><span className="source-type">{source.type === "webdav" ? "WebDAV" : "NAS"}</span><b className="source-mark">{source.type === "webdav" ? "W" : "N"}</b><span className="source-count">{source.file_count || 0}<small>个文件</small></span></div><div className="source-meta"><h3>{source.name}</h3><small>{source.base_path}</small></div></Link>)}</div>}
    </section>
    <MediaSection title="最近播放" items={continued} wide emptyText="还没有未看完的内容" />
    <UpNextSection items={upNext} loading={loading} />
    <MediaSection title="最近添加" items={recent} wide emptyText="暂无新增媒体" />
  </main>;
}

function UpNextSection({ items, loading }: { items: UpNext[]; loading: boolean }) {
  if (!loading && items.length === 0) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return <section className="media-section">
    <div className="section-heading"><h2>接下来</h2><span>{items.length} 部</span></div>
    {loading ? <div className="empty">正在整理接下来...</div> : <div className="continue-grid">{items.map((item, index) => <article className="media-card" key={item.id}><Link className="poster-card" to={`/watch/${item.id}`}><PosterBg path={item.work_poster} className={`poster art-${index % 6}`}><span>SERIES</span><b>{item.work_poster ? "" : item.work_title.slice(0, 1)}</b></PosterBg><h3>{item.work_title}</h3><p>看完 S{pad(item.from_season)}E{pad(item.from_episode)} · 下一集 S{pad(item.season)}E{pad(item.episode)}</p></Link></article>)}</div>}
  </section>;
}

function Library({ kind }: { kind: "movie" | "show" }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Work[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState<number>();
  const [message, setMessage] = useState("");
  const reqIdRef = useRef(0);
  useEffect(() => {
    setLoading(true);
    const reqId = ++reqIdRef.current;
    const handle = window.setTimeout(() => {
      api<Work[]>(`/works?kind=${kind}&q=${encodeURIComponent(query)}`).then((rows) => {
        // Only keep the result of the latest request to avoid stale overwrites.
        if (reqId === reqIdRef.current) setItems(rows);
      }).catch(() => {}).finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
    }, 300);
    return () => window.clearTimeout(handle);
  }, [kind, query]);
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
    <WorkSection title={`全部${kind === "movie" ? "电影" : "剧集"}`} items={items} loading={loading} refreshingId={refreshingId} onRefresh={refreshItem} />
  </main>;
}

function WorkSection({ title, items, loading, refreshingId, onRefresh }: { title: string; items: Work[]; loading?: boolean; refreshingId?: number; onRefresh?: (id: number) => void }) {
  const [menuId, setMenuId] = useState<number>();
  const [manageWork, setManageWork] = useState<Work>();
  useEffect(() => {
    if (menuId === undefined) return;
    const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest(".media-menu, .media-more")) setMenuId(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuId(undefined); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menuId]);
  return <section className="media-section">
    <div className="section-heading"><h2>{title}</h2><span>{items.length} 部</span></div>
    {loading ? <div className="empty">正在整理作品...</div> : items.length === 0 ? <div className="empty"><strong>银幕还没有亮起</strong><span>前往“媒体源”扫描你的影视目录。</span><Link className="text-link" to="/admin">管理媒体源 →</Link></div> : <div className="poster-grid">{items.map((item, index) => <article className="media-card" key={item.id}><Link className="poster-card" to={`/work/${item.id}`}><PosterBg path={item.poster_path} className={`poster art-${index % 6}`}><span>{item.kind === "show" ? "SERIES" : "FILM"}</span><b>{item.poster_path ? "" : item.title.slice(0, 1)}</b></PosterBg><h3>{item.title}</h3><p>{item.year || "未匹配年份"} · {item.kind === "show" ? `${item.season_count} 季` : `${item.file_count} 个版本`}</p></Link><button className="media-more" type="button" aria-label="更多操作" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setMenuId(menuId === item.id ? undefined : item.id); }}>⋯</button>{menuId === item.id && <div className="media-menu"><button type="button" disabled={refreshingId === item.id} onClick={() => { setMenuId(undefined); onRefresh?.(item.id); }}>{refreshingId === item.id ? "刮削中..." : "重新刮削"}</button><button type="button" onClick={() => { setMenuId(undefined); setManageWork(item); }}>编辑文件信息</button><button type="button" className="danger-text" onClick={() => { setMenuId(undefined); setManageWork(item); }}>删除文件</button></div>}</article>)}</div>}
    {manageWork && <WorkFilesDialog work={manageWork} onClose={() => setManageWork(undefined)} />}
  </section>;
}

function WorkFilesDialog({ work, onClose }: { work: Work; onClose: () => void }) {
  const [data, setData] = useState<{ work: Work; media: Media[] }>();
  const [editing, setEditing] = useState<Media>();
  useEffect(() => { api<{ work: Work; media: Media[] }>(`/works/${work.id}`).then(setData); }, [work.id]);
  if (!data) return <div className="drawer-mask" onClick={onClose}><div className="drawer" onClick={(e) => e.stopPropagation()}><div className="empty">正在读取文件...</div></div></div>;
  async function remove(item: Media) {
    if (!window.confirm(`确定删除「${item.path.split("/").pop()}」吗？此操作不可恢复。`)) return;
    try { await api(`/media/${item.id}`, { method: "DELETE" }); setData((current) => current ? { ...current, media: current.media.filter((file) => file.id !== item.id) } : current); }
    catch (error) { window.alert((error as Error).message); }
  }
  return <div className="drawer-mask" onClick={onClose}><div className="drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">MEDIA FILES</span><h2>{work.title}</h2></div><button type="button" className="icon-close" aria-label="关闭" onClick={onClose}>×</button></div><p className="drawer-desc">这里管理该作品下的全部媒体文件。编辑会同步修改实际文件信息，删除会删除实际文件。</p><div className="work-files-list">{data.media.length === 0 ? <div className="empty">没有可用文件</div> : data.media.map((item) => <div className="work-file-row" key={item.id}><div><strong>{item.kind === "show" && item.season ? `S${String(item.season).padStart(2, "0")}E${String(item.episode || 0).padStart(2, "0")}` : item.title}</strong><small>{item.path.split("/").pop()}</small></div><div><button className="ghost" type="button" onClick={() => setEditing(item)}>编辑</button><button className="ghost danger" type="button" onClick={() => void remove(item)}>删除</button></div></div>)}</div><div className="drawer-actions"><button type="button" className="secondary" onClick={onClose}>关闭</button></div>{editing && <MediaEditDialog item={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onClose(); }} />}</div></div>;
}

function MediaSection({ title, items, loading, wide = false, emptyText }: { title: string; items: Media[]; loading?: boolean; wide?: boolean; emptyText?: string }) {
  const [menuId, setMenuId] = useState<number>();
  const [editing, setEditing] = useState<Media>();
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [refreshingWorkId, setRefreshingWorkId] = useState<number>();
  const visible = items.filter((item) => !removed.has(item.id));
  useEffect(() => {
    if (menuId === undefined) return;
    const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest(".media-menu, .media-more")) setMenuId(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuId(undefined); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menuId]);
  async function remove(item: Media) {
    if (!window.confirm(`确定删除「${item.title}」对应的文件吗？此操作不可恢复。`)) return;
    try {
      await api(`/media/${item.id}`, { method: "DELETE" });
      setRemoved((current) => new Set(current).add(item.id));
      setMenuId(undefined);
    } catch (error) {
      window.alert((error as Error).message);
      setMenuId(undefined);
    }
  }
  async function refresh(item: Media) {
    if (!item.work_id || refreshingWorkId) return;
    setRefreshingWorkId(item.work_id);
    try { await api(`/works/${item.work_id}/metadata/refresh`, { method: "POST" }); window.location.reload(); }
    catch (error) { window.alert((error as Error).message); setRefreshingWorkId(undefined); }
  }
  return <section className="media-section">
    <div className="section-heading"><h2>{title}</h2><span>{visible.length} 部</span></div>
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
      </Link><button className="media-more" type="button" aria-label="更多操作" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setMenuId(menuId === item.id ? undefined : item.id); }}>⋯</button>{menuId === item.id && <div className="media-menu"><button type="button" disabled={!item.work_id || refreshingWorkId === item.work_id} onClick={() => void refresh(item)}>{refreshingWorkId === item.work_id ? "刮削中..." : "重新刮削"}</button><button type="button" onClick={() => { setEditing(item); setMenuId(undefined); }}>编辑文件信息</button><button type="button" className="danger-text" onClick={() => void remove(item)}>删除文件</button></div>}</article>;
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

function BrowseView() {
  const params = useParams();
  const navigate = useNavigate();
  const initialSourceId = Number(params.sourceId || 0);
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [path, setPath] = useState("");
  const [data, setData] = useState<BrowseResult>();
  const [loading, setLoading] = useState(true);

  useEffect(() => { setSourceId(Number(params.sourceId || 0)); setPath(""); setData(undefined); }, [params.sourceId]);
  useEffect(() => {
    if (!sourceId) {
      navigate("/", { replace: true });
      return;
    }
    setLoading(true);
    api<BrowseResult>(`/browse?sourceId=${sourceId}&path=${encodeURIComponent(path)}`).then(setData).finally(() => setLoading(false));
  }, [sourceId, path, navigate]);

  function openFolder(folderPath: string) { setPath(folderPath); }
  function goCrumb(crumbPath: string) { setPath(crumbPath); }

  return <main>
    <header className="topbar">
      <div><span className="eyebrow">FILE BROWSER</span><h1>{data?.source?.name || "浏览媒体"}</h1></div>
      <Link className="back-inline" to="/">← 返回首页</Link>
    </header>
    {loading || !data ? <div className="empty">正在读取目录...</div> : <>
      <div className="crumbs">
        <button type="button" onClick={() => navigate("/")}>我的媒体</button>
        {data.crumbs.map((crumb) => <button type="button" key={`${crumb.path}-${crumb.name}`} onClick={() => goCrumb(crumb.path)}>{crumb.name}</button>)}
      </div>
      <div className="folder-list">
        {data.folders.map((folder) => <button type="button" className="folder-row" key={folder.path} onClick={() => openFolder(folder.path)}>
          <span className="folder-badge">DIR</span><b>{folder.name}</b><small>{folder.file_count} 个文件</small>
        </button>)}
        {data.files.map((file) => <Link className="folder-row file" key={file.id} to={`/watch/${file.id}`}>
          <span className="folder-badge">VID</span>
          <b>{file.name || file.title}</b>
          <small>{file.kind === "show" && file.season ? `S${String(file.season).padStart(2, "0")}E${String(file.episode).padStart(2, "0")}` : file.container?.toUpperCase() || "VIDEO"}{file.size ? ` · ${Math.round(file.size / 1024 / 1024)} MB` : ""}{file.position ? " · 继续" : ""}</small>
        </Link>)}
        {data.folders.length === 0 && data.files.length === 0 && <div className="empty">这个目录下没有媒体文件</div>}
      </div>
    </>}
  </main>;
}

function Detail() { const { id } = useParams(); const [item, setItem] = useState<Media>(); const [error, setError] = useState(""); useEffect(() => { setItem(undefined); setError(""); api<Media>(`/media/${id}`).then(setItem).catch((e) => setError((e as Error).message)); }, [id]); if (error) return <main className="detail"><div className="empty"><strong>载入失败</strong><p>{error}</p><Link className="text-link" to="/" onClick={(e) => { e.preventDefault(); location.reload(); }}>重试</Link></div></main>; if (!item) return <div className="empty">载入中...</div>; return <main className="detail"><div className="detail-top"><LibraryBack kind={item.kind} /></div><div className="detail-art"><span>{item.kind === "show" ? "ORIGINAL SERIES" : "FEATURE PRESENTATION"}</span><b>{item.title.slice(0, 1)}</b></div><section><span className="eyebrow">{item.kind === "show" ? "剧集" : "电影"} · {item.source_name}</span><h1>{item.title}</h1><p className="meta">{item.container?.toUpperCase() || "VIDEO"}　{item.video_codec || "待探测"}　{item.duration ? `${Math.round(item.duration / 60)} 分钟` : ""}</p><p className="description">来自你的私人媒体库。FPlayer 会通过安全的服务端链路读取文件，并自动保存观看进度。</p><Link className="primary play" to={`/watch/${item.id}`}>{item.position ? "▶ 继续播放" : "▶ 开始播放"}</Link></section></main>; }

function WorkDetail() {
  const { id } = useParams();
  const [data, setData] = useState<{ work: Work; media: Media[] }>();
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedMediaId, setSelectedMediaId] = useState<number>();
  const load = () => api<{ work: Work; media: Media[] }>(`/works/${id}`).then((d) => { setData(d); setLoadError(""); }).catch((e) => setLoadError((e as Error).message));
  useEffect(() => { setData(undefined); setLoadError(""); void load(); }, [id]);
  async function refreshMetadata() {
    if (!id || refreshing) return;
    setRefreshing(true); setMessage("");
    try { await api(`/works/${id}/metadata/refresh`, { method: "POST" }); await load(); setMessage("已更新"); }
    catch (error) { setMessage((error as Error).message); }
    finally { setRefreshing(false); }
  }
  if (loadError) return <div className="empty"><strong>载入失败</strong><p>{loadError}</p><button className="text-link" type="button" onClick={() => void load()}>重试</button></div>;
  if (!data) return <div className="empty">载入作品...</div>;
  const seasons = [...new Set(data.media.map((item) => item.season).filter(Boolean))] as number[];
  const selectedMedia = data.media.find((item) => item.id === selectedMediaId) || data.media.find((item) => item.position && !item.completed) || data.media[0];
  const hasMetadata = Boolean(data.work.poster_path && data.work.overview);
  const formatMedia = (item: Media) => [item.container?.toUpperCase() || "VIDEO", item.video_codec?.toUpperCase(), item.duration ? `${Math.round(item.duration / 60)} 分钟` : undefined, item.size ? `${Math.round(item.size / 1024 / 1024)} MB` : undefined].filter(Boolean).join(" · ");
  return <main className="work-detail"><div className="work-detail-top"><LibraryBack kind={data.work.kind} /></div><PosterBg path={data.work.poster_path} className="detail-art"><b>{data.work.poster_path ? "" : data.work.title.slice(0, 1)}</b></PosterBg><section><span className="eyebrow">{data.work.kind === "show" ? "剧集" : "电影"} · {data.work.year || "未匹配年份"}</span><h1>{data.work.title}</h1>{data.work.kind === "movie" && <><p className="meta">{selectedMedia ? formatMedia(selectedMedia) : "暂无可播放文件"}</p><Link className={`primary play work-play ${selectedMedia ? "" : "disabled"}`} to={selectedMedia ? `/watch/${selectedMedia.id}` : "#"} onClick={(e) => { if (!selectedMedia) e.preventDefault(); }}>▶ {selectedMedia?.position && !selectedMedia.completed ? "继续播放" : "开始播放"}</Link></>}<div className={`work-overview ${hasMetadata ? "" : "missing"}`}><p className="description">{data.work.overview || "影片资料尚未匹配完整，匹配后可补齐中文简介和海报。"}</p><div className="metadata-context"><span>{hasMetadata ? "资料由豆瓣匹配" : "缺少影片资料"}</span><button type="button" onClick={refreshMetadata} disabled={refreshing}>{refreshing ? "正在匹配..." : hasMetadata ? "重新匹配" : "匹配影片资料"}</button>{message && <small className={message === "已更新" ? "success" : "error"}>{message}</small>}</div></div>{data.work.kind === "show" ? <div className="episodes">{seasons.map((season) => { const episodes = Object.values(data.media.filter((item) => item.season === season).reduce<Record<string, Media>>((map, item) => { const key = String(item.episode); if (!map[key] || (item.size || 0) > (map[key].size || 0)) map[key] = item; return map; }, {})).sort((a, b) => (a.episode || 0) - (b.episode || 0)); return <div key={season}><h3>第 {season} 季 · {episodes.length} 集</h3>{episodes.map((item) => <Link className="episode" to={`/watch/${item.id}`} key={item.id}><span>S{String(item.season).padStart(2, "0")}E{String(item.episode || 0).padStart(2, "0")}</span><b>第 {item.episode} 集{item.position && !item.completed ? " · 继续" : ""}</b><small>{item.size ? `${Math.round(item.size / 1024 / 1024)} MB` : ""}</small></Link>)}</div>; })}</div> : data.media.length > 1 && <div className="versions"><h3>选择版本</h3>{data.media.map((item, index) => <button type="button" className={item.id === selectedMedia?.id ? "active" : ""} onClick={() => setSelectedMediaId(item.id)} key={item.id}><span><b>版本 {index + 1}</b><small>{item.path.split("/").pop()}</small></span><em>{formatMedia(item)}</em></button>)}</div>}</section></main>;
}

// Sorts a work's episodes across seasons, keeping the largest file when an
// episode number has multiple versions.
function sortEpisodes(media: Media[]): Media[] {
  const byKey = new Map<string, Media>();
  for (const item of media) {
    if (item.season == null || item.episode == null) continue;
    const key = `${item.season}-${item.episode}`;
    const existing = byKey.get(key);
    if (!existing || (item.size || 0) > (existing.size || 0)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => (a.season! - b.season!) || (a.episode! - b.episode!));
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// HEVC is not decodable in most browsers, so those files always go through
// transcoding. Other codecs play natively; if the browser still can't decode
// them, the video error handler falls back to transcoding once.
function needsTranscode(codec?: string) {
  return /hevc|h265|hev1|hvc1/i.test(codec || "");
}

type Quality = "original" | "1080" | "720";
const QUALITY_LABEL: Record<Quality, string> = { original: "原画", "1080": "1080P", "720": "720P" };

const playerIcon = (d: string) => <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d={d} /></svg>;
const PLAY_ICON = playerIcon("M8 5v14l11-7z");
const PAUSE_ICON = playerIcon("M6 5h4v14H6zM14 5h4v14h-4z");
const SKIP_PREV_ICON = playerIcon("M6 6h2v12H6zm3.5 6l8.5 6V6z");
const SKIP_NEXT_ICON = playerIcon("M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z");
const VOLUME_ICON = playerIcon("M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z");
const MUTED_ICON = playerIcon("M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z");
const QUALITY_ICON = playerIcon("M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11v6zm2-6h4.5c.83 0 1.5.67 1.5 1.5v3c0 .83-.67 1.5-1.5 1.5H13v-6zm1.5 4.5h2v-3h-2v3z");
const FULLSCREEN_ICON = playerIcon("M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z");
const FULLSCREEN_EXIT_ICON = playerIcon("M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z");

function PlayerRoute() {
  const { id } = useParams();
  // Remount the player when switching episodes so playback state resets cleanly.
  return <Player key={id} />;
}

function Player() {
  const { id } = useParams(); const navigate = useNavigate();
  const [item, setItem] = useState<Media>(); const [error, setError] = useState("");
  const [buffering, setBuffering] = useState(false);
  const [status, setStatus] = useState("");
  const [needsTap, setNeedsTap] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [episodes, setEpisodes] = useState<Media[]>([]);
  const [playback, setPlayback] = useState({ currentTime: 0, duration: 0, buffered: 0, volume: 1, muted: false, playing: false });
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [playMode, setPlayMode] = useState<"direct" | "transcode" | null>(null);
  const [quality, setQuality] = useState<Quality>("original");
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const hlsRef = useRef<Hls | null>(null);
  const lastSavedRef = useRef(0);
  const lastPositionRef = useRef(0);
  const userSeekRef = useRef(false);
  const lastUserSeekRef = useRef(0);
  const chromeTimerRef = useRef<number | undefined>(undefined);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);
  // Resume offset of the transcode stream: the HLS starts at this position of
  // the source file, so playback times are offset by it.
  const offsetRef = useRef(0);
  // Position to restore when switching back to direct playback.
  const pendingSeekRef = useRef(0);
  // Verifies a seek landed where the user asked; hls.js live streams snap
  // out-of-window seeks to the live edge instead of seeking precisely.
  const pendingSeekTimerRef = useRef<number | undefined>(undefined);
  // Current transcode session id so quality switches can stop it early.
  const transcodeSessionRef = useRef("");
  useEffect(() => {
    let active = true;
    api<Media>(`/media/${id}`).then((m) => { if (active) setItem(m); }).catch((e) => { if (active) setError((e as Error).message); });
    return () => { active = false; };
  }, [id]);

  // Decide how to play: natively, or directly through transcoding. When the
  // codec is unknown (never probed), probe it once and cache it in the media
  // row. This avoids ever streaming the original file to a browser that can't
  // decode it — the main cause of full-file downloads and drive rate limits.
  useEffect(() => {
    if (!item || playMode) return;
    if (item.video_codec) {
      const trans = needsTranscode(item.video_codec);
      if (trans) setQuality("1080");
      setPlayMode(trans ? "transcode" : "direct");
      return;
    }
    let active = true;
    setStatus("正在探测媒体信息...");
    setBuffering(true);
    api<{ media: Media }>(`/media/${id}/probe`, { method: "POST" })
      .then(({ media }) => {
        if (!active) return;
        setItem(media);
        const trans = needsTranscode(media.video_codec);
        if (trans) setQuality("1080");
        setPlayMode(trans ? "transcode" : "direct");
      })
      .catch(() => { if (active) setPlayMode("direct"); })
      .finally(() => { if (active) { setBuffering(false); setStatus(""); } });
    return () => { active = false; };
  }, [item, id, playMode]);

  // Start (or restart, after a quality switch) transcoding as soon as the
  // video element exists.
  useEffect(() => {
    if (playMode !== "transcode" || !video) return;
    if (transcodeSessionRef.current) {
      api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
      transcodeSessionRef.current = "";
    }
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    const resume = Math.max(0, playback.currentTime + offsetRef.current);
    void startTranscode(video, resume > 5 ? resume : (item?.position && item.position > 5 ? item.position : 0), quality);
  }, [playMode, video, quality]);

  // Load the episode list of the parent work so we can navigate prev/next.
  useEffect(() => {
    if (!item?.work_id) { setEpisodes([]); return; }
    let active = true;
    api<{ work: Work; media: Media[] }>(`/works/${item.work_id}`).then((d) => { if (active) setEpisodes(d.media); }).catch(() => {});
    return () => { active = false; };
  }, [item?.work_id]);

  // Keep the transcode session alive while the player is mounted. HLS stops
  // requesting segments while paused, which would otherwise leave lastAccess
  // stale and let the idle reaper kill the ffmpeg process mid-episode.
  useEffect(() => {
    if (playMode !== "transcode") return;
    const timer = window.setInterval(() => {
      if (transcodeSessionRef.current) api(`/transcode/${transcodeSessionRef.current}/keepalive`).catch(() => {});
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, [playMode]);
  const sortedEpisodes = useMemo(() => sortEpisodes(episodes), [episodes]);
  const currentIndex = sortedEpisodes.findIndex((m) => String(m.id) === id);
  const prevEpisode = currentIndex > 0 ? sortedEpisodes[currentIndex - 1] : undefined;
  const nextEpisode = currentIndex >= 0 && currentIndex < sortedEpisodes.length - 1 ? sortedEpisodes[currentIndex + 1] : undefined;
  const episodeLabel = (m: Media) => `S${String(m.season).padStart(2, "0")}E${String(m.episode || 0).padStart(2, "0")}`;

  async function startTranscode(target: HTMLVideoElement, start = 0, q: Quality = "1080") {
    if (target.dataset.transcoding) return;
    target.dataset.transcoding = "true";
    offsetRef.current = start;
    setError("");
    setStatus("正在启动转码...");
    setBuffering(true);
    // Never keep the direct /file stream while ffmpeg reads the same file.
    // Two concurrent downloads of a large file double upstream traffic and
    // easily trip the drive's rate limit.
    target.removeAttribute("src");
    target.load();
    try {
      const result = await api<{ playlist: string }>(`/media/${id}/transcode`, { method: "POST", body: JSON.stringify({ start, quality: q }) });
      transcodeSessionRef.current = result.playlist.split("/")[3];
      // The playlist URL uses the session only; segments are authorized via a
      // short-lived signature embedded by the server, so the main token never
      // appears in the playlist/segment URLs.
      const source = result.playlist;
      if (Hls.isSupported()) {
        hlsRef.current?.destroy();
        const hls = new Hls({ xhrSetup: (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${getToken()}`), fragLoadingMaxRetry: 30, fragLoadingRetryDelay: 1500, fragLoadingTimeOut: 30000, manifestLoadingMaxRetry: 4 });
        hlsRef.current = hls;
        hls.loadSource(source); hls.attachMedia(target);
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) { setError("转码播放失败，请重试"); setBuffering(false); setStatus(""); } });
      } else {
        // Native HLS (e.g. iOS): no custom headers possible, rely on the signed
        // segment URLs rewritten by the server into the playlist.
        target.src = source;
      }
      setError("");
      setStatus("");
    } catch (e) {
      // Mark as failed and leave the src empty: restore it only through "重试"
      // so a failed transcode doesn't loop back into the direct stream.
      target.dataset.transcoding = "failed";
      setError((e as Error).message);
      setStatus("");
    } finally { setBuffering(false); }
  }

  function transcode() {
    if (!video || video.dataset.transcoding) return;
    // Only fall back to transcoding for format/decode issues, not transient
    // network errors, and only try it once — after a failure the "重试" button
    // restores the direct stream for a manual retry.
    const code = video.error?.code;
    if (code === MediaError.MEDIA_ERR_NETWORK) { setError("网络错误，请检查连接后重试"); setBuffering(false); return; }
    void startTranscode(video, item?.position && item.position > 5 ? item.position : 0, quality);
  }

  async function switchQuality(q: Quality) {
    if (q === quality || !video) return;
    setQualityMenuOpen(false);
    const resume = Math.max(0, playback.currentTime + offsetRef.current);
    setQuality(q);
    if (q === "original" && !needsTranscode(item?.video_codec)) {
      // Back to the direct stream: stop the transcode and seek to the resume point.
      if (transcodeSessionRef.current) {
        api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
        transcodeSessionRef.current = "";
      }
      hlsRef.current?.destroy(); hlsRef.current = null;
      video.dataset.transcoding = "";
      offsetRef.current = 0;
      pendingSeekRef.current = resume;
      setPlayMode("direct");
    } else {
      // A quality change restarts the transcode from the current position.
      setPlayMode("transcode");
    }
  }

  function save(element: HTMLVideoElement, force = false) {
    // Trust the probed source duration over the transcode stream's duration:
    // the HLS window starts at the resume offset and its duration is unstable.
    const probedDuration = item?.duration && item.duration > 0 ? item.duration : undefined;
    const duration = probedDuration ?? (Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0);
    // While a seek is still being verified the element may report the live-edge
    // snap instead of the user's drag target; persist the requested position.
    const rawPosition = element.currentTime + offsetRef.current;
    const position = pendingSeekTimerRef.current !== undefined && pendingSeekRef.current > 0 ? pendingSeekRef.current : rawPosition;
    if (duration <= 0 || position <= 0) return;
    // A failed/stalled playback reports currentTime 0 — never let it erase a
    // meaningful saved position.
    if (position < 5 && (item?.position ?? 0) > 30) return;
    // Guard against HLS live-edge jumps: seeking past the transcoded window
    // makes hls.js snap to the newest segment, which would fake a huge
    // position (and a false "completed"). User drags are marked via userSeek.
    const prev = lastPositionRef.current;
    lastPositionRef.current = position;
    if (prev > 30 && position - prev > 120 && !userSeekRef.current) return;
    const now = Date.now();
    // Throttle with wall-clock time so a backwards seek still persists on pause.
    if (!force && now - lastSavedRef.current < 5000) return;
    lastSavedRef.current = now;
    // A live transcode stream reports a duration that tracks the downloaded
    // window, so completion can only be judged against a trusted duration.
    const reliable = probedDuration !== undefined || Math.abs(element.duration - position) < 60;
    const remaining = duration - position;
    // Dragging the timeline into the final stretch is not the same as watching
    // it through: only playback that actually reaches the very end, or natural
    // playback persisting well past a user seek, may mark the media completed.
    // A pending seek check also blocks completion: the position may still be
    // the live-edge snap rather than where the user actually dragged.
    const watchedThrough = remaining < 2 || Date.now() - lastUserSeekRef.current > 30000;
    const completed = reliable && remaining < Math.min(90, duration * 0.05) && watchedThrough && pendingSeekTimerRef.current === undefined;
    api(`/media/${id}/progress`, { method: "PUT", body: JSON.stringify({ position: Math.min(position, duration), duration, completed }) }).catch(() => {});
  }

  // Hold the latest save() in a ref so the unmount cleanup below always calls
  // the current render's closure (which captures the loaded item) instead of
  // the one from when the video element was first bound.
  const saveRef = useRef(save);
  saveRef.current = save;

  // Persist progress when leaving the player (navigating away or switching episodes).
  useEffect(() => () => { if (video) saveRef.current(video, true); }, [video]);

  const seekStateRef = useRef({ longPressActive: false, longPressTimer: 0 as number | undefined, previousRate: 1, pressedKey: "" as "" | "ArrowRight" | "ArrowLeft" });
  useEffect(() => {
    if (!video) return;
    const LONG_PRESS_DELAY = 400;
    const SEEK_SECONDS = 5;
    function clearLongPressTimer() { const state = seekStateRef.current; if (state.longPressTimer !== undefined) { window.clearTimeout(state.longPressTimer); state.longPressTimer = undefined; } }
    function resetSeekState() { const state = seekStateRef.current; clearLongPressTimer(); if (state.longPressActive && video) video.playbackRate = state.previousRate; state.longPressActive = false; state.pressedKey = ""; }
    function onKeyDown(event: KeyboardEvent) {
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
      if (!video) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        nudgeVolume(event.key === "ArrowUp" ? 0.1 : -0.1);
        return;
      }
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      const state = seekStateRef.current;
      if (state.pressedKey === event.key) return;
      state.pressedKey = event.key as "ArrowRight" | "ArrowLeft";
      state.longPressActive = false;
      state.previousRate = video.playbackRate;
      clearLongPressTimer();
      state.longPressTimer = window.setTimeout(() => {
        state.longPressActive = true;
        video!.playbackRate = event.key === "ArrowRight" ? 2 : 0.5;
      }, LONG_PRESS_DELAY);
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      if (!video) return;
      const state = seekStateRef.current;
      if (state.pressedKey !== event.key) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearLongPressTimer();
      if (state.longPressActive) {
        video.playbackRate = state.previousRate;
        state.longPressActive = false;
      } else {
        video.currentTime += event.key === "ArrowRight" ? SEEK_SECONDS : -SEEK_SECONDS;
        lastUserSeekRef.current = Date.now();
        verifySeek(video.currentTime + offsetRef.current);
      }
      state.pressedKey = "";
    }
    const onBlur = () => resetSeekState();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => { window.removeEventListener("keydown", onKeyDown, true); window.removeEventListener("keyup", onKeyUp, true); window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onBlur); clearLongPressTimer(); };
  }, [video]);

  // Clean up HLS instance on unmount or when switching media.
  useEffect(() => () => { hlsRef.current?.destroy(); hlsRef.current = null; if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current); if (pendingSeekTimerRef.current) { window.clearTimeout(pendingSeekTimerRef.current); pendingSeekTimerRef.current = undefined; } }, []);

  // When entering fullscreen, blur the video so keyboard focus leaves the
  // shadow DOM. This lets arrow keys reach our window seek handler and prevents
  // a focus ring on the fullscreen button.
  useEffect(() => {
    if (!video) return;
    const onFsChange = () => { if (document.fullscreenElement) { (document.activeElement as HTMLElement | null)?.blur(); window.focus(); } };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [video]);
  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  function showChrome() {
    setChromeVisible(true);
    if (chromeTimerRef.current) window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = window.setTimeout(() => { if (video && !video.paused) setChromeVisible(false); }, 2600);
  }

  function goBack() {
    // 从哪来回哪去：播放页可能从首页/片库/浏览/详情进入，返回上一页即可；
    // 直接打开无历史时才回退到固定页面。
    if (window.history.length > 1) { navigate(-1); return; }
    if (item?.work_id) navigate(`/work/${item.work_id}`, { replace: true });
    else navigate(item?.kind === "show" ? "/shows" : "/movies", { replace: true });
  }

  function switchEpisode(target: Media) {
    if (video) save(video, true);
    // Replace so the back stack stays flat: returning exits to wherever the
    // player was opened from, instead of walking back through every episode.
    navigate(`/watch/${target.id}`, { replace: true });
  }

  // Restarts the transcode session from a new source position (used when the
  // user seeks ahead of the transcoded window — hls.js would otherwise snap to
  // the live edge and play the wrong part of the episode).
  function restartTranscode(at: number) {
    if (!video || playMode !== "transcode") return;
    if (transcodeSessionRef.current) {
      api(`/transcode/${transcodeSessionRef.current}`, { method: "DELETE" }).catch(() => {});
      transcodeSessionRef.current = "";
    }
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    offsetRef.current = at;
    void startTranscode(video, at, quality);
  }

  // hls.js treats the transcode stream as live (no ENDLIST until ffmpeg
  // finishes), and a seek outside its sliding window snaps to the live edge —
  // which, when the transcode has nearly caught up with the source, is the
  // very end of the file. That fakes a huge position (and a false
  // "completed"). Verify shortly after the seek where the player actually
  // landed, and restart the transcode at the real target if it snapped.
  function verifySeek(target: number) {
    if (playMode !== "transcode") return;
    if (pendingSeekTimerRef.current) window.clearTimeout(pendingSeekTimerRef.current);
    pendingSeekRef.current = target;
    pendingSeekTimerRef.current = window.setTimeout(() => {
      pendingSeekTimerRef.current = undefined;
      pendingSeekRef.current = 0;
      if (!video) return;
      const actual = video.currentTime + offsetRef.current;
      if (Math.abs(actual - target) > 30) restartTranscode(target);
    }, 500);
  }

  function seekVideo(absTarget: number) {
    if (!video) return;
    if (playMode === "transcode" && absTarget > playback.currentTime + offsetRef.current + 60) {
      const bufferedEnd = video.buffered.length ? video.buffered.end(video.buffered.length - 1) + offsetRef.current : 0;
      if (absTarget > bufferedEnd + 30) {
        restartTranscode(absTarget);
        return;
      }
    }
    video.currentTime = absTarget - offsetRef.current;
    verifySeek(absTarget);
  }

  function retry() {
    if (!video) return;
    hlsRef.current?.destroy(); hlsRef.current = null;
    video.dataset.transcoding = "";
    offsetRef.current = 0;
    setError(""); setStatus(""); setNeedsTap(false); setBuffering(true);
    if (playMode === "transcode") {
      // HEVC: restart the transcode directly, never the direct stream.
      void startTranscode(video, item?.position && item.position > 5 ? item.position : 0, quality);
    } else {
      video.src = `/api/media/${id}/file?token=${getToken()}`;
      video.load();
      video.play().catch(() => setNeedsTap(true));
    }
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused) { const p = video.play(); if (p && typeof p.then === "function") p.catch(() => {}); }
    else video.pause();
  }
  function setVolume(value: number) {
    if (!video) return;
    const v = Math.min(1, Math.max(0, value));
    video.volume = v;
    video.muted = v === 0;
    setPlayback((p) => ({ ...p, volume: v, muted: video.muted }));
  }
  function nudgeVolume(delta: number) {
    if (!video) return;
    showChrome();
    // Unmuting raises from the previous level (or a sensible default), not from 0.
    if (video.muted && delta > 0) setVolume(video.volume > 0 ? video.volume : 0.5);
    else if (!video.muted) setVolume(video.volume + delta);
  }
  function toggleMute() {
    if (!video) return;
    if (video.muted) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.5;
    } else {
      video.muted = true;
    }
    setPlayback((p) => ({ ...p, volume: video.volume, muted: video.muted }));
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }
  function timeFromPointer(event: { clientX: number }) {
    const el = timelineRef.current;
    const duration = item?.duration && item.duration > 0 ? item.duration : playback.duration;
    // A live transcode stream can report Infinity as its duration (or 0 before
    // metadata loads) — never turn that into a seek target.
    if (!el || !video || !Number.isFinite(duration) || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  const ratioOf = (t: number) => (playback.duration > 0 ? Math.min(100, Math.max(0, (t / playback.duration) * 100)) : 0);
  const playRatio = ratioOf(playback.currentTime + offsetRef.current);
  const bufferedRatio = ratioOf(playback.buffered + offsetRef.current);
  const hoverRatio = hoverTime !== null ? ratioOf(hoverTime) : null;
  const clampedHoverRatio = hoverRatio === null ? null : Math.min(96, Math.max(4, hoverRatio));

  return <main className={`player-page ${chromeVisible ? "chrome-visible" : ""}`} onMouseMove={showChrome} onPointerDown={showChrome}>
    <div className="player-chrome"><button className="player-back" onClick={goBack} aria-label="返回详情"><span>‹</span></button><div className="player-heading"><small>正在播放{item?.kind === "show" && item?.season ? ` · ${episodeLabel(item)}` : ""}</small><strong>{item?.title}</strong></div></div>
    <video ref={setVideo} autoPlay playsInline
      src={playMode === "direct" ? `/api/media/${id}/file?token=${getToken()}` : undefined}
      onClick={togglePlay}
      onLoadedMetadata={(e) => {
        // Grab the element synchronously: React state updaters run later, when
        // the synthetic event's currentTarget has already been reset to null.
        const v = e.currentTarget;
        setPlayback((p) => ({ ...p, duration: item?.duration && item.duration > 0 ? item.duration : (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0) }));
        // The transcode stream already starts at the resume position; the
        // direct stream restores either the quality-switch point or the saved position.
        if (playMode === "direct") {
          const seek = pendingSeekRef.current || item?.position;
          if (seek) { v.currentTime = seek; pendingSeekRef.current = 0; }
        }
        const p = v.play(); if (p && typeof p.then === "function") p.catch(() => setNeedsTap(true));
      }}
      onDurationChange={(e) => {
        const v = e.currentTarget;
        setPlayback((p) => ({ ...p, duration: item?.duration && item.duration > 0 ? item.duration : (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0) }));
      }}
      onWaiting={() => setBuffering(true)}
      onPlaying={() => { setBuffering(false); setStatus(""); showChrome(); setPlayback((p) => ({ ...p, playing: true })); }}
      onPause={() => { if (video) save(video); setChromeVisible(true); setPlayback((p) => ({ ...p, playing: false })); }}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        save(v);
        const buf = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
        setPlayback((p) => {
          if (Math.abs(v.currentTime - p.currentTime) < 0.25 && Math.abs(buf - p.buffered) < 1) return p;
          return { ...p, currentTime: v.currentTime, buffered: buf };
        });
      }}
      onEnded={(e) => { save(e.currentTarget, true); setPlayback((p) => ({ ...p, playing: false })); }}
      onError={() => {
        // Only auto-transcode once: after a failed attempt the "重试" button
        // is the way back in, so repeated error events don't spin up endless
        // new transcode sessions against the upstream drive.
        if (video?.dataset.transcoding === "failed") return;
        transcode();
      }}
    />
    <div className={`player-controls ${chromeVisible ? "visible" : ""}`}>
      {item?.kind === "show" && sortedEpisodes.length > 0 && <button className="player-btn ep-skip-btn" type="button" aria-label="上一集" disabled={!prevEpisode} title={prevEpisode ? `上一集 ${episodeLabel(prevEpisode)}` : "已经是第一集"} onClick={() => prevEpisode && switchEpisode(prevEpisode)}>{SKIP_PREV_ICON}</button>}
      <button className="player-btn" type="button" aria-label={playback.playing ? "暂停" : "播放"} onClick={(e) => { e.currentTarget.blur(); togglePlay(); }}>{playback.playing ? PAUSE_ICON : PLAY_ICON}</button>
      {item?.kind === "show" && sortedEpisodes.length > 0 && <button className="player-btn ep-skip-btn" type="button" aria-label="下一集" disabled={!nextEpisode} title={nextEpisode ? `下一集 ${episodeLabel(nextEpisode)}` : "已经是最后一集"} onClick={() => nextEpisode && switchEpisode(nextEpisode)}>{SKIP_NEXT_ICON}</button>}
      <div className="player-volume-wrap">
        <button className="player-btn" type="button" aria-label={playback.muted ? "取消静音" : "静音"} onClick={(e) => { e.currentTarget.blur(); toggleMute(); }}>{playback.muted || playback.volume === 0 ? MUTED_ICON : VOLUME_ICON}</button>
        <div className="player-volume-slider">
          <input type="range" min="0" max="1" step="0.05" value={playback.muted ? 0 : playback.volume} aria-label="音量"
            onChange={(e) => setVolume(Number(e.target.value))}
            onPointerDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
      <div className="player-timeline" ref={timelineRef}
        onPointerDown={(e) => { if (!video) return; e.currentTarget.setPointerCapture(e.pointerId); dragRef.current = true; userSeekRef.current = true; window.setTimeout(() => { userSeekRef.current = false; }, 3000); const t = timeFromPointer(e); setHoverTime(t); if (t > offsetRef.current) seekVideo(t); }}
        onPointerMove={(e) => { const t = timeFromPointer(e); if (dragRef.current && t > offsetRef.current) seekVideo(t); setHoverTime(t); }}
        onPointerUp={() => { dragRef.current = false; }}
        onPointerCancel={() => { dragRef.current = false; }}
        onPointerLeave={() => { if (!dragRef.current) setHoverTime(null); }}
      >
        <div className="player-timeline-track">
          <i className="player-timeline-buffered" style={{ width: `${bufferedRatio}%` }} />
          <i className="player-timeline-fill" style={{ width: `${playRatio}%` }} />
          <i className="player-timeline-thumb" style={{ left: `${playRatio}%` }} />
          {hoverRatio !== null && <i className="player-timeline-preview" style={{ left: `${hoverRatio}%` }} />}
        </div>
        {hoverRatio !== null && clampedHoverRatio !== null && <span className="player-timeline-time" style={{ left: `${clampedHoverRatio}%` }}>{formatTime(hoverTime ?? 0)}</span>}
      </div>
      <span className="player-time">{formatTime(playback.currentTime + offsetRef.current)} / {formatTime(playback.duration)}</span>
      <div className="player-quality-wrap">
        <button className="player-btn quality-btn" type="button" onClick={(e) => { e.currentTarget.blur(); setQualityMenuOpen((open) => !open); }}>{QUALITY_ICON}<span>{QUALITY_LABEL[quality]}</span></button>
        {qualityMenuOpen && <div className="player-quality-menu">{(Object.keys(QUALITY_LABEL) as Quality[]).map((q) => <button key={q} className={q === quality ? "active" : ""} type="button" onClick={() => void switchQuality(q)}>{QUALITY_LABEL[q]}{q === "original" ? " · 原分辨率" : ""}</button>)}</div>}
      </div>
      <button className="player-btn" type="button" aria-label={fullscreen ? "退出全屏" : "全屏"} onClick={(e) => { e.currentTarget.blur(); toggleFullscreen(); }}>{fullscreen ? FULLSCREEN_EXIT_ICON : FULLSCREEN_ICON}</button>
    </div>
    {buffering && !error && <div className="player-status" role="status"><i className="player-spinner" /><strong>{status || "正在缓冲"}</strong></div>}
    {needsTap && <button className="player-tap" type="button" onClick={() => { video?.play().then(() => setNeedsTap(false)).catch(() => {}); }}>▶ 点击播放</button>}
    {error && <div className="player-error" role="alert"><span>播放遇到问题</span><strong>{error}</strong><div><button type="button" className="primary" onClick={retry}>重试</button><button type="button" className="secondary" onClick={goBack}>返回详情</button></div></div>}
  </main>;
}

const emptySourceForm = { name: "", type: "webdav", basePath: "", username: "", password: "" };

function SourceAdmin({ jobs, refreshJobs }: { jobs: ScanJob[]; refreshJobs: (jobs: ScanJob[]) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [editingId, setEditingId] = useState<number>();
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState(emptySourceForm);
  const [meta, setMeta] = useState<{ running: boolean; pending: number; matchedWorks: number; hasCookie?: boolean; avoidRiskControl?: boolean; gapMs?: number; job?: { status: string; phase: string; total: number; processed: number; matched: number; skipped: number; failed: number; current_title?: string; error?: string } | null }>();
  const [doubanForm, setDoubanForm] = useState({ cookies: "", avoidRiskControl: true });
  const [loginInfo, setLoginInfo] = useState<{ isLogined?: boolean; name?: string }>({});
  const [showDouban, setShowDouban] = useState(false);
  const [busyId, setBusyId] = useState<number>();
  const load = () => api<Source[]>("/sources").then(setSources);
  const loadMeta = () => api<typeof meta>("/metadata/status").then(setMeta).catch(() => {});
  const loadDoubanSettings = () => api<{ cookies: string; avoidRiskControl: boolean }>("/metadata/settings").then((s) => setDoubanForm({ cookies: s.cookies || "", avoidRiskControl: s.avoidRiskControl !== false })).catch(() => {});
  useEffect(() => { load(); loadMeta(); loadDoubanSettings(); }, []);
  useEffect(() => {
    if (!meta?.running) return;
    const timer = window.setInterval(loadMeta, 1500);
    return () => window.clearInterval(timer);
  }, [meta?.running]);

  function openCreate() {
    setEditingId(undefined);
    setForm(emptySourceForm);
    setShowForm(true);
    setMessage("");
  }
  function openEdit(source: Source) {
    setEditingId(source.id);
    setForm({ name: source.name, type: source.type, basePath: source.base_path, username: source.username || "", password: "" });
    setShowForm(true);
    setMessage("");
  }
  function closeForm() {
    setShowForm(false);
    setEditingId(undefined);
    setForm(emptySourceForm);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api(editingId ? `/sources/${editingId}` : "/sources", { method: editingId ? "PUT" : "POST", body: JSON.stringify(form) });
      setMessage(editingId ? "媒体源已更新" : "媒体源已添加");
      closeForm();
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function action(id: number, name: "test" | "scan") {
    setBusyId(id);
    setMessage(name === "scan" ? "扫描任务已提交" : "正在测试连接...");
    try {
      await api(`/sources/${id}/${name}`, { method: "POST" });
      if (name === "test") setMessage("连接成功");
      else refreshJobs(await api<ScanJob[]>("/scans"));
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusyId(undefined);
    }
  }
  async function stop(job: ScanJob) {
    try {
      await api(`/scans/${job.id}/stop`, { method: "POST" });
      setMessage("正在停止扫描...");
      refreshJobs(await api<ScanJob[]>("/scans"));
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function remove(source: Source) {
    if (!window.confirm(`确定删除「${source.name}」吗？\n对应媒体记录与观看进度也会删除。`)) return;
    try {
      await api(`/sources/${source.id}`, { method: "DELETE" });
      if (editingId === source.id) closeForm();
      setMessage("媒体源已删除");
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function refreshMetadata() {
    try {
      await api("/metadata/refresh", { method: "POST" });
      setMessage("元数据匹配已在后台运行");
      await loadMeta();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function stopMetadata() {
    try {
      await api("/metadata/stop", { method: "POST" });
      setMessage("正在停止匹配...");
      await loadMeta();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function saveDouban() {
    try {
      await api("/metadata/settings", { method: "PUT", body: JSON.stringify(doubanForm) });
      setMessage("豆瓣 Cookie 已保存");
      await loadMeta();
      await loadDoubanSettings();
    } catch (error) {
      setMessage((error as Error).message);
      throw error;
    }
  }
  async function checkLogin() {
    try {
      const info = await api<{ isLogined: boolean; name: string }>("/metadata/check-login", { method: "POST" });
      setLoginInfo(info);
      setMessage(info.isLogined ? `豆瓣已登录：${info.name}` : "豆瓣未登录或 Cookie 无效");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  const metaJob = meta?.job;
  const metaRunning = Boolean(meta?.running);
  const metaPercent = metaJob && metaJob.total ? Math.round((metaJob.processed / metaJob.total) * 100) : 0;

  return <main className="admin-page">
    <header className="topbar">
      <div>
        <span className="eyebrow">CONTROL ROOM</span>
        <h1>媒体源</h1>
      </div>
      <button className="primary" onClick={openCreate}>＋ 添加媒体源</button>
    </header>

    {message && <div className="admin-toast">{message}<button type="button" aria-label="关闭" onClick={() => setMessage("")}>×</button></div>}

    <section className="admin-stats">
      <article className="stat-card">
        <span>媒体源</span>
        <strong>{sources.length}</strong>
      </article>
      <article className="stat-card">
        <span>已匹配</span>
        <strong>{meta?.matchedWorks ?? 0}</strong>
      </article>
      <article className="stat-card">
        <span>待匹配</span>
        <strong>{meta?.pending ?? 0}</strong>
      </article>
      <article className="stat-card meta-card">
        <div className="meta-head">
          <div>
            <span>豆瓣元数据</span>
            <p>{metaRunning ? (metaJob?.current_title ? `正在匹配：${metaJob.current_title}` : "匹配进行中") : "后台异步 · 已匹配自动跳过"}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button className="ghost" type="button" onClick={() => { setShowDouban(true); loadDoubanSettings(); }}>Cookie</button>
            {metaRunning
              ? <button className="ghost danger" onClick={stopMetadata}>停止</button>
              : <button className="ghost accent" onClick={refreshMetadata}>开始匹配</button>}
          </div>
        </div>
        {metaRunning && <div className="progress-bar"><i style={{ width: `${metaPercent}%` }} /><em>{metaPercent}%</em></div>}
        {!metaRunning && metaJob?.status === "completed" && <small>上次完成：新增 {metaJob.matched} · 跳过 {metaJob.skipped} · 失败 {metaJob.failed}</small>}
        {!metaRunning && metaJob?.status === "failed" && <small className="error-text">{metaJob.error || "匹配失败"}</small>}
        <small>{meta?.hasCookie ? "已配置 Cookie" : "未配置 Cookie"} · 间隔 {meta?.gapMs ?? 5000}ms · {meta?.avoidRiskControl === false ? "防封禁关" : "防封禁开"}</small>
      </article>
    </section>

    {showDouban && <div className="drawer-mask" onClick={() => setShowDouban(false)}>
      <form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void saveDouban().then(() => setShowDouban(false)); }}>
        <div className="drawer-head">
          <div>
            <span className="eyebrow">DOUBAN</span>
            <h2>设置豆瓣 Cookie</h2>
          </div>
          <button type="button" className="icon-close" aria-label="关闭" onClick={() => setShowDouban(false)}>×</button>
        </div>
        <p className="drawer-desc">浏览器登录 movie.douban.com 后，复制 Cookie 粘贴到这里并保存。保存后可点「检测登录」验证。</p>
        <label>豆瓣 Cookie<textarea rows={6} value={doubanForm.cookies} onChange={(e) => setDoubanForm({ ...doubanForm, cookies: e.target.value })} placeholder='bid=xxx; dbcl2="xxx"; ck=xxx; ...' required /></label>
        <label className="checkbox-row">
          <input type="checkbox" checked={doubanForm.avoidRiskControl} onChange={(e) => setDoubanForm({ ...doubanForm, avoidRiskControl: e.target.checked })} />
          <span>开启防封禁（未登录约 5s/次，登录约 3s/次）</span>
        </label>
        <div className="drawer-actions">
          <button type="button" className="ghost" onClick={checkLogin}>检测登录</button>
          <button type="button" className="secondary" onClick={() => setShowDouban(false)}>取消</button>
          <button className="primary" type="submit">保存 Cookie</button>
        </div>
        {loginInfo.isLogined !== undefined && <small style={{ color: "#7d7a73" }}>{loginInfo.isLogined ? `当前登录：${loginInfo.name || "已登录"}` : "当前未登录或 Cookie 无效"}</small>}
      </form>
    </div>}

    <section className="source-board">
      <div className="section-heading"><h2>已连接存储</h2><span>{sources.length} 个</span></div>
      {sources.length === 0 ? <div className="empty-card"><strong>尚未添加媒体源</strong><p>连接 NAS 目录或 WebDAV 后即可扫描入库。</p><button className="primary" onClick={openCreate}>添加第一个媒体源</button></div> : <div className="source-cards">{sources.map((source) => {
        const job = jobs.find((item) => item.source_id === source.id && ["queued", "running"].includes(item.status));
        const scanPercent = job?.phase === "indexing" && job.discovered ? Math.round(job.processed / job.discovered * 100) : undefined;
        const busy = busyId === source.id;
        return <article className={`source-card ${job ? "is-scanning" : ""}`} key={source.id}>
          <div className="source-card-main">
            <div className="source-icon">{source.type === "webdav" ? "W" : "N"}</div>
            <div className="source-info">
              <div className="source-title-row">
                <h3>{source.name}</h3>
                <span className="source-tag">{source.type === "webdav" ? "WebDAV" : "本地"}</span>
              </div>
              <p>{source.base_path}</p>
              <small>{source.last_scan_at ? `上次扫描 ${source.last_scan_at}` : "尚未扫描"}{source.last_error ? ` · ${source.last_error}` : ""}</small>
              {job && <div className="progress-bar scan"><i style={{ width: `${scanPercent ?? 35}%` }} /><em>{job.phase === "indexing" ? `索引 ${job.processed}/${job.discovered}` : job.phase === "discovering" ? `发现 ${job.discovered}` : "扫描中"}</em></div>}
            </div>
          </div>
          <div className="source-toolbar">
            {job
              ? <button className="ghost danger" onClick={() => stop(job)}>停止扫描</button>
              : <>
                <button className="ghost" disabled={busy} onClick={() => action(source.id, "test")}>测试</button>
                <button className="ghost accent" disabled={busy} onClick={() => action(source.id, "scan")}>扫描</button>
                <button className="ghost" onClick={() => openEdit(source)}>编辑</button>
                <button className="ghost danger" onClick={() => remove(source)}>删除</button>
              </>}
          </div>
        </article>;
      })}</div>}
    </section>

    {showForm && <div className="drawer-mask" onClick={closeForm}>
      <form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="drawer-head">
          <div>
            <span className="eyebrow">{editingId ? "EDIT SOURCE" : "NEW SOURCE"}</span>
            <h2>{editingId ? "编辑媒体源" : "添加媒体源"}</h2>
          </div>
          <button type="button" className="icon-close" aria-label="关闭" onClick={closeForm}>×</button>
        </div>
        <p className="drawer-desc">{editingId ? "留空密码将保留原凭证。修改后建议重新测试并扫描。" : "凭证会加密保存在 NAS 数据目录中。"}</p>
        <label>显示名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：家庭影院" required /></label>
        <label>存储类型<select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="webdav">WebDAV</option><option value="local">NAS 本地目录</option></select></label>
        <label>{form.type === "webdav" ? "WebDAV 地址" : "容器内目录"}<input value={form.basePath} onChange={(e) => setForm({ ...form, basePath: e.target.value })} placeholder={form.type === "webdav" ? "https://dav.example.com/media/" : "/media"} required /></label>
        {form.type === "webdav" && <>
          <label>用户名<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label>密码 / Token<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={editingId ? "留空则不修改" : ""} /></label>
        </>}
        <div className="drawer-actions">
          <button type="button" className="secondary" onClick={closeForm}>取消</button>
          <button className="primary" type="submit">{editingId ? "保存修改" : "添加"}</button>
        </div>
      </form>
    </div>}
  </main>;
}

export default function App() {
  const [initialized, setInitialized] = useState<boolean>();
  const [user, setUser] = useState<User>();
  useEffect(() => {
    setOnUnauthorized(() => setUser(undefined));
    // Wait for both /setup and /me (if a token exists) before rendering, so a
    // logged-in user never flashes the Auth page during startup.
    const setupP = api<{ initialized: boolean }>("/setup").then((r) => r.initialized).catch(() => false);
    const meP = getToken() ? api<{ user: User }>("/me").then((r) => r.user).catch(() => { clearToken(); return undefined; }) : Promise.resolve(undefined);
    Promise.all([setupP, meP]).then(([init, u]) => { setInitialized(init); setUser(u); });
    return () => setOnUnauthorized(null);
  }, []);
  if (initialized === undefined) return <div className="splash">F</div>;
  if (!user) return <Auth initialized={initialized} onLogin={setUser} onSetupDone={() => setInitialized(true)} />;
  return <Layout user={user} logout={() => { clearToken(); setUser(undefined); }} />;
}
