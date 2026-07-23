import { useEffect, useState } from "react";
import Hls from "hls.js";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, clearToken, getToken, setToken, type BrowseResult, type Media, type ScanJob, type Source, type User, type Work } from "./api";

function Auth({ initialized, onLogin }: { initialized: boolean; onLogin: (user: User) => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) { event.preventDefault(); setError(""); try { if (!initialized) await api("/setup", { method: "POST", body: JSON.stringify({ username, password }) }); const result = await api<{ token: string; user: User }>("/login", { method: "POST", body: JSON.stringify({ username, password }) }); setToken(result.token); onLogin(result.user); } catch (e) { setError((e as Error).message); } }
  return <main className="auth-page"><section className="auth-copy"><span className="eyebrow">YOUR SCREEN. YOUR STORAGE.</span><h1>让收藏，<br />重新开场。</h1><p>连接 NAS 与 WebDAV，在任何浏览器中进入你的私人放映室。</p></section><form className="auth-card" onSubmit={submit}><div className="brand-mark">F</div><div><span className="eyebrow">FPLAYER</span><h2>{initialized ? "欢迎回来" : "创建管理员"}</h2></div><label>用户名<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required /></label><label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></label>{error && <p className="error">{error}</p>}<button className="primary" type="submit">{initialized ? "进入媒体库" : "创建并进入"}</button><small>{initialized ? "使用你的本地账户登录" : "首个账户将成为系统管理员"}</small></form></main>;
}

function Layout({ user, logout }: { user: User; logout: () => void }) {
  const location = useLocation(); const [jobs, setJobs] = useState<ScanJob[]>([]);
  useEffect(() => { let active = true; const refresh = () => api<ScanJob[]>("/scans").then((rows) => { if (active) setJobs(rows); }).catch(() => {}); refresh(); const timer = window.setInterval(refresh, 1500); return () => { active = false; window.clearInterval(timer); }; }, []);
  async function dismiss(job: ScanJob) { await api(`/scans/${job.id}/acknowledge`, { method: "POST" }); setJobs((current) => current.filter((item) => item.id !== job.id)); }
  const finished = jobs.filter((job) => ["completed", "failed", "cancelled"].includes(job.status));
  return <div className="shell"><aside><Link className="logo" to="/"><span>F</span> FPLAYER</Link><nav><Link className={location.pathname === "/" ? "active" : ""} to="/">⌂ <span>首页</span></Link><Link className={location.pathname.startsWith("/movies") ? "active" : ""} to="/movies">◫ <span>电影</span></Link><Link className={location.pathname.startsWith("/shows") ? "active" : ""} to="/shows">▤ <span>剧集</span></Link><Link className={location.pathname.startsWith("/admin") ? "active" : ""} to="/admin">⚙ <span>媒体源</span></Link></nav><div className="account"><div className="avatar">{user.username[0].toUpperCase()}</div><div><strong>{user.username}</strong><button onClick={logout}>退出登录</button></div></div></aside><div className="content"><Routes><Route path="/" element={<Home />} /><Route path="/movies" element={<Library kind="movie" />} /><Route path="/shows" element={<Library kind="show" />} /><Route path="/browse" element={<BrowseView />} /><Route path="/browse/:sourceId" element={<BrowseView />} /><Route path="/work/:id" element={<WorkDetail />} /><Route path="/media/:id" element={<Detail />} /><Route path="/watch/:id" element={<Player />} /><Route path="/admin" element={<SourceAdmin jobs={jobs} refreshJobs={(rows) => setJobs(rows)} />} /></Routes></div>{finished.length > 0 && <div className="notifications">{finished.map((job) => <article className={`toast ${job.status}`} key={job.id}><div><strong>{job.source_name}：{job.status === "completed" ? "扫描完成" : job.status === "cancelled" ? "扫描已停止" : "扫描失败"}</strong><p>{job.status === "completed" ? `共发现并更新 ${job.result_count || 0} 个媒体文件` : job.error}</p></div><button onClick={() => dismiss(job)}>×</button></article>)}</div>}</div>;
}

function posterUrl(value?: string) { return value ? `${value}?token=${getToken()}` : undefined; }

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
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<BrowseResult>("/browse").then((data) => setSources(data.sources || [])),
      api<Media[]>("/continue?limit=12").then(setContinued).catch(() => setContinued([])),
      api<Media[]>("/recent?limit=10").then(setRecent).catch(() => setRecent([])),
    ]).finally(() => setLoading(false));
  }, []);
  return <main>
    <header className="topbar"><div><span className="eyebrow">PRIVATE CINEMA</span><h1>今晚，看点什么？</h1></div></header>
    <section className="media-section">
      <div className="section-heading"><h2>我的媒体</h2><span>{sources.length} 个</span></div>
      {loading ? <div className="empty">正在载入媒体源...</div> : sources.length === 0 ? <div className="empty"><strong>还没有媒体源</strong><span>前往“媒体源”添加 NAS 或 WebDAV。</span><Link className="text-link" to="/admin">添加媒体源 →</Link></div> : <div className="folder-grid">{sources.map((source) => <Link className="folder-card" key={source.id} to={`/browse/${source.id}`}><div className="folder-icon">{source.type === "webdav" ? "W" : "N"}</div><div><h3>{source.name}</h3><p>{source.file_count || 0} 个媒体文件</p><small>{source.base_path}</small></div></Link>)}</div>}
    </section>
    <MediaSection title="最近播放" items={continued} wide emptyText="还没有未看完的内容" />
    <MediaSection title="最近添加" items={recent} wide emptyText="暂无新增媒体" />
  </main>;
}

function Library({ kind }: { kind: "movie" | "show" }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Work[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState<number>();
  const [message, setMessage] = useState("");
  useEffect(() => {
    setLoading(true);
    api<Work[]>(`/works?kind=${kind}&q=${encodeURIComponent(query)}`).then(setItems).finally(() => setLoading(false));
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
    {message && <div className="admin-toast">{message}<button type="button" onClick={() => setMessage("")}>×</button></div>}
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
    {loading ? <div className="empty">正在整理作品...</div> : items.length === 0 ? <div className="empty"><strong>银幕还没有亮起</strong><span>前往“媒体源”扫描你的影视目录。</span><Link className="text-link" to="/admin">管理媒体源 →</Link></div> : <div className="poster-grid">{items.map((item, index) => <article className="media-card" key={item.id}><Link className="poster-card" to={`/work/${item.id}`}><div className={`poster art-${index % 6}`} style={item.poster_path ? { backgroundImage: `url(${posterUrl(item.poster_path)})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}><span>{item.kind === "show" ? "SERIES" : "FILM"}</span><b>{item.poster_path ? "" : item.title.slice(0, 1)}</b></div><h3>{item.title}</h3><p>{item.year || "未匹配年份"} · {item.kind === "show" ? `${item.season_count} 季` : `${item.file_count} 个版本`}</p></Link><button className="media-more" type="button" aria-label="更多操作" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setMenuId(menuId === item.id ? undefined : item.id); }}>⋯</button>{menuId === item.id && <div className="media-menu"><button type="button" disabled={refreshingId === item.id} onClick={() => { setMenuId(undefined); onRefresh?.(item.id); }}>{refreshingId === item.id ? "刮削中..." : "重新刮削"}</button><button type="button" onClick={() => { setMenuId(undefined); setManageWork(item); }}>编辑文件信息</button><button type="button" className="danger-text" onClick={() => { setMenuId(undefined); setManageWork(item); }}>删除文件</button></div>}</article>)}</div>}
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
  return <div className="drawer-mask" onClick={onClose}><div className="drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">MEDIA FILES</span><h2>{work.title}</h2></div><button type="button" className="icon-close" onClick={onClose}>×</button></div><p className="drawer-desc">这里管理该作品下的全部媒体文件。编辑会同步修改实际文件信息，删除会删除实际文件。</p><div className="work-files-list">{data.media.length === 0 ? <div className="empty">没有可用文件</div> : data.media.map((item) => <div className="work-file-row" key={item.id}><div><strong>{item.kind === "show" && item.season ? `S${String(item.season).padStart(2, "0")}E${String(item.episode || 0).padStart(2, "0")}` : item.title}</strong><small>{item.path.split("/").pop()}</small></div><div><button className="ghost" type="button" onClick={() => setEditing(item)}>编辑</button><button className="ghost danger" type="button" onClick={() => void remove(item)}>删除</button></div></div>)}</div><div className="drawer-actions"><button type="button" className="secondary" onClick={onClose}>关闭</button></div>{editing && <MediaEditDialog item={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onClose(); }} />}</div></div>;
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
    await api(`/media/${item.id}`, { method: "DELETE" });
    setRemoved((current) => new Set(current).add(item.id));
    setMenuId(undefined);
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
        <div className={`poster art-${index % 6}`} style={poster ? { backgroundImage: `url(${posterUrl(poster)})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
          <span>{item.kind === "show" ? "SERIES" : "FILM"}</span>
          <b>{poster ? "" : item.title.slice(0, 1)}</b>
          {percent > 0 && <i style={{ width: `${percent}%` }} />}
        </div>
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
  return <div className="drawer-mask" onClick={onClose}><form className="drawer" onClick={(e) => e.stopPropagation()} onSubmit={save}><div className="drawer-head"><div><span className="eyebrow">MEDIA FILE</span><h2>修改文件信息</h2></div><button type="button" className="icon-close" onClick={onClose}>×</button></div><p className="drawer-desc">修改文件名会同步重命名实际媒体文件，原始路径目录保持不变。</p><label>原始文件名<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label><label>显示标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label><div className="media-edit-row"><label>季<input type="number" min="1" value={form.season} onChange={(e) => setForm({ ...form, season: e.target.value })} /></label><label>集<input type="number" min="1" value={form.episode} onChange={(e) => setForm({ ...form, episode: e.target.value })} /></label></div>{error && <p className="error">{error}</p>}<div className="drawer-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" type="submit">保存修改</button></div></form></div>;
}

function BrowseView() {
  const params = useParams();
  const navigate = useNavigate();
  const initialSourceId = Number(params.sourceId || 0);
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [path, setPath] = useState("");
  const [data, setData] = useState<BrowseResult>();
  const [loading, setLoading] = useState(true);

  useEffect(() => { setSourceId(Number(params.sourceId || 0)); setPath(""); }, [params.sourceId]);
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

function Detail() { const { id } = useParams(); const [item, setItem] = useState<Media>(); useEffect(() => { api<Media>(`/media/${id}`).then(setItem); }, [id]); if (!item) return <div className="empty">载入中...</div>; return <main className="detail"><div className="detail-top"><LibraryBack kind={item.kind} /></div><div className="detail-art"><span>{item.kind === "show" ? "ORIGINAL SERIES" : "FEATURE PRESENTATION"}</span><b>{item.title.slice(0, 1)}</b></div><section><span className="eyebrow">{item.kind === "show" ? "剧集" : "电影"} · {item.source_name}</span><h1>{item.title}</h1><p className="meta">{item.container?.toUpperCase() || "VIDEO"}　{item.video_codec || "待探测"}　{item.duration ? `${Math.round(item.duration / 60)} 分钟` : ""}</p><p className="description">来自你的私人媒体库。FPlayer 会通过安全的服务端链路读取文件，并自动保存观看进度。</p><Link className="primary play" to={`/watch/${item.id}`}>{item.position ? "▶ 继续播放" : "▶ 开始播放"}</Link></section></main>; }

function WorkDetail() {
  const { id } = useParams();
  const [data, setData] = useState<{ work: Work; media: Media[] }>();
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const load = () => api<{ work: Work; media: Media[] }>(`/works/${id}`).then(setData);
  useEffect(() => { void load(); }, [id]);
  async function refreshMetadata() {
    if (!id || refreshing) return;
    setRefreshing(true); setMessage("正在重新刮削...");
    try { await api(`/works/${id}/metadata/refresh`, { method: "POST" }); await load(); setMessage("刮削完成"); }
    catch (error) { setMessage((error as Error).message); }
    finally { setRefreshing(false); }
  }
  if (!data) return <div className="empty">载入作品...</div>;
  const seasons = [...new Set(data.media.map((item) => item.season).filter(Boolean))] as number[];
  return <main className="work-detail"><div className="work-detail-top"><LibraryBack kind={data.work.kind} /></div><div className="detail-art" style={data.work.poster_path ? { backgroundImage: `url(${posterUrl(data.work.poster_path)})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}><b>{data.work.poster_path ? "" : data.work.title.slice(0, 1)}</b></div><section><span className="eyebrow">{data.work.kind === "show" ? "剧集" : "电影"} · {data.work.year || "未匹配年份"}</span><h1>{data.work.title}</h1><div className="work-actions"><button className="ghost accent" onClick={refreshMetadata} disabled={refreshing}>{refreshing ? "刮削中..." : "重新刮削"}</button>{message && <small>{message}</small>}</div><p className="description">{data.work.overview || "尚未匹配简介。可点击“重新刮削”，用豆瓣补齐中文简介和海报。"}</p>{data.work.kind === "show" ? <div className="episodes">{seasons.map((season) => { const episodes = Object.values(data.media.filter((item) => item.season === season).reduce<Record<string, Media>>((map, item) => { const key = String(item.episode); if (!map[key] || (item.size || 0) > (map[key].size || 0)) map[key] = item; return map; }, {})).sort((a, b) => (a.episode || 0) - (b.episode || 0)); return <div key={season}><h3>第 {season} 季 · {episodes.length} 集</h3>{episodes.map((item) => <Link className="episode" to={`/watch/${item.id}`} key={item.id}><span>S{String(item.season).padStart(2, "0")}E{String(item.episode).padStart(2, "0")}</span><b>第 {item.episode} 集</b><small>{item.size ? `${Math.round(item.size / 1024 / 1024)} MB` : ""}</small></Link>)}</div>; })}</div> : <Link className="primary play" to={`/watch/${data.media[0]?.id}`}>▶ 开始播放</Link>}</section></main>;
}

function Player() { const { id } = useParams(); const navigate = useNavigate(); const [item, setItem] = useState<Media>(); const [error, setError] = useState(""); const [video, setVideo] = useState<HTMLVideoElement | null>(null); useEffect(() => { api<Media>(`/media/${id}`).then(setItem); }, [id]); async function transcode() { if (!video || video.dataset.transcoding) return; video.dataset.transcoding = "true"; setError("原格式不兼容，正在启动 FFmpeg 转码..."); try { const result = await api<{ playlist: string }>(`/media/${id}/transcode`, { method: "POST" }); const source = `${result.playlist}?token=${getToken()}`; if (Hls.isSupported()) { const hls = new Hls({ xhrSetup: (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${getToken()}`) }); hls.loadSource(source); hls.attachMedia(video); } else { video.src = source; } setError(""); } catch (e) { setError((e as Error).message); } } function save(element: HTMLVideoElement) { if (!Number.isFinite(element.duration)) return; api(`/media/${id}/progress`, { method: "PUT", body: JSON.stringify({ position: element.currentTime, duration: element.duration, completed: element.duration - element.currentTime < 90 }) }).catch(() => {}); } return <main className="player-page"><button className="player-back" onClick={() => navigate(-1)}>← 返回</button><video ref={setVideo} controls autoPlay src={`/api/media/${id}/file?token=${getToken()}`} onLoadedMetadata={(e) => { if (item?.position) e.currentTarget.currentTime = item.position; }} onTimeUpdate={(e) => { if (Math.floor(e.currentTarget.currentTime) % 10 === 0) save(e.currentTarget); }} onPause={(e) => save(e.currentTarget)} onError={transcode}/><div className="player-title"><span>正在播放</span><strong>{item?.title}</strong>{error && <p className="error">{error}</p>}</div></main>; }

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

    {message && <div className="admin-toast">{message}<button type="button" onClick={() => setMessage("")}>×</button></div>}

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
          <button type="button" className="icon-close" onClick={() => setShowDouban(false)}>×</button>
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
          <button type="button" className="icon-close" onClick={closeForm}>×</button>
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

export default function App() { const [initialized, setInitialized] = useState<boolean>(); const [user, setUser] = useState<User>(); useEffect(() => { api<{ initialized: boolean }>("/setup").then((result) => setInitialized(result.initialized)); if (getToken()) api<{ user: User }>("/me").then((result) => setUser(result.user)).catch(clearToken); }, []); if (initialized === undefined) return <div className="splash">F</div>; if (!user) return <Auth initialized={initialized} onLogin={setUser} />; return <Layout user={user} logout={() => { clearToken(); setUser(undefined); }} />; }
